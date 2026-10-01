import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { storage } from "../storage";
import { logger } from "../lib/logger";
import { notifyUser } from "../lib/push";
import {
  verifyProductPurchase,
  acknowledgeProductPurchase,
  consumeProductPurchase,
} from "../lib/googlePlay";
import { appAccountTokenFor, decodeJwsPayload, getAppStoreTransaction, iosBundleId } from "../lib/appStore";

// Needs requireAuth — mount under the authenticated section.
const router: IRouter = Router();
// Public: store notification endpoints are called by Google/Apple with no
// Firebase auth token — mount before requireAuth.
const webhookRouter: IRouter = Router();

// Maps each consumable product ID to how many scan credits it grants. The
// same ID must be created in both Play Console and App Store Connect.
const SCAN_PACKS: Record<string, number> = {
  scan_pack_50: 50,
};

class BillingError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type CreditOutcome =
  | { status: "credited"; scansRemaining: number }
  | { status: "pending" };

// Verifies an Android purchase with Google and credits it. Safe to call
// repeatedly for the same token: crediting is idempotent, and acknowledge
// and consume are skipped once already done.
async function creditAndroidPurchase(expectedUserId: string | null, productId: string, purchaseToken: string): Promise<CreditOutcome> {
  const scansGranted = SCAN_PACKS[productId];
  if (!scansGranted) throw new BillingError(400, "Unknown product");

  const status = await verifyProductPurchase(productId, purchaseToken);

  // A UPI/cash payment that hasn't gone through yet. Google sends an RTDN
  // when it completes, which credits it via the webhook below.
  if (status.state === "pending") return { status: "pending" };
  if (!status.isPurchased) throw new BillingError(400, "This purchase isn't valid.");

  // The app sets obfuscatedAccountId to the buyer's Firebase UID. Requiring
  // it means a purchase token can only ever be credited to the account that
  // made the purchase, never replayed onto another one.
  const ownerId = status.obfuscatedExternalAccountId;
  if (!ownerId) throw new BillingError(403, "This purchase isn't linked to a Videofy account.");
  if (expectedUserId && ownerId !== expectedUserId) {
    throw new BillingError(403, "This purchase belongs to a different account.");
  }

  if (status.acknowledgementState !== "acknowledged") {
    await acknowledgeProductPurchase(productId, purchaseToken);
  }

  const { user, newlyGranted } = await storage.grantScanCredits(ownerId, productId, purchaseToken, scansGranted, "android");

  // Credited from the webhook (a pending UPI/cash payment completing) — the
  // user is probably not in the app, so tell them.
  if (newlyGranted && expectedUserId === null) {
    void notifyUser(ownerId, `+${scansGranted} scans added`, `Your payment went through. You now have ${user.scansRemaining} scans.`, { type: "credited" });
  }

  // Consumed server-side so the pack can be bought again even if the app is
  // killed before it finishes the transaction itself.
  if (!status.alreadyConsumed) {
    await consumeProductPurchase(productId, purchaseToken);
  }

  return { status: "credited", scansRemaining: user.scansRemaining };
}

async function creditIosPurchase(userId: string, productId: string, transactionId: string): Promise<CreditOutcome> {
  const scansGranted = SCAN_PACKS[productId];
  if (!scansGranted) throw new BillingError(400, "Unknown product");

  const tx = await getAppStoreTransaction(transactionId);
  if (!tx) throw new BillingError(400, "This purchase isn't valid.");
  if (tx.bundleId !== iosBundleId() || tx.productId !== productId) {
    throw new BillingError(400, "This purchase isn't valid.");
  }
  if (tx.revocationDate) throw new BillingError(400, "This purchase was refunded.");
  if (tx.appAccountToken !== appAccountTokenFor(userId)) {
    throw new BillingError(403, "This purchase belongs to a different account.");
  }

  const { user } = await storage.grantScanCredits(userId, productId, transactionId, scansGranted, "ios");
  return { status: "credited", scansRemaining: user.scansRemaining };
}

const VerifyBody = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("android"),
    productId: z.string().min(1),
    purchaseToken: z.string().min(1),
  }),
  z.object({
    platform: z.literal("ios"),
    productId: z.string().min(1),
    transactionId: z.string().min(1),
  }),
]);

router.post("/billing/verify", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  // Older app builds sent { purchaseToken, productId } with no platform.
  const body = req.body && !req.body.platform ? { ...req.body, platform: "android" } : req.body;
  const parsed = VerifyBody.safeParse(body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body" }); return; }

  try {
    const outcome = parsed.data.platform === "android"
      ? await creditAndroidPurchase(req.userId, parsed.data.productId, parsed.data.purchaseToken)
      : await creditIosPurchase(req.userId, parsed.data.productId, parsed.data.transactionId);

    if (outcome.status === "pending") {
      res.status(202).json({ status: "pending" });
      return;
    }
    res.json({ status: "credited", scansRemaining: outcome.scansRemaining });
  } catch (err) {
    if (err instanceof BillingError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, platform: parsed.data.platform }, "Failed to verify store purchase");
    res.status(500).json({ error: "Failed to verify purchase" });
  }
});

router.get("/billing/purchases", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const rows = await storage.listPurchases(req.userId);
    res.json(rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      platform: r.platform,
      scansGranted: r.scansGranted,
      createdAt: r.createdAt.toISOString(),
      refunded: r.revokedAt != null,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to list purchases");
    res.status(500).json({ error: "Failed to load purchases" });
  }
});

// Pub/Sub push endpoint for Google Play Real-time Developer Notifications.
// Configure the push subscription's endpoint URL as
// .../api/billing/rtdn?token=<RTDN_WEBHOOK_SECRET>.
webhookRouter.post("/billing/rtdn", async (req, res) => {
  const expectedSecret = process.env.RTDN_WEBHOOK_SECRET;
  if (!expectedSecret || req.query.token !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Ack immediately — Pub/Sub retries on anything but a 2xx, and a slow Play
  // API call shouldn't cause redelivery storms. Failures are logged instead.
  res.status(204).end();

  try {
    const messageData = (req.body as { message?: { data?: string } })?.message?.data;
    if (!messageData) return;

    const decoded = JSON.parse(Buffer.from(messageData, "base64").toString("utf8")) as {
      oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
      voidedPurchaseNotification?: { purchaseToken?: string };
    };

    // Refunds and chargebacks arrive as voided purchases.
    const voidedToken = decoded.voidedPurchaseNotification?.purchaseToken;
    if (voidedToken) {
      const userId = await storage.revokeScanCredits(voidedToken);
      if (userId) void notifyUser(userId, "Refund processed", "Your scan pack was refunded, so its scans were removed.", { type: "refunded" });
      return;
    }

    const notification = decoded.oneTimeProductNotification;
    if (!notification?.purchaseToken || !notification.sku) return;

    // ONE_TIME_PRODUCT_PURCHASED = 1. This is how a pending (UPI/cash)
    // payment gets credited once it completes, even if the app is closed.
    // The buyer comes from obfuscatedAccountId on the purchase itself.
    if (notification.notificationType === 1) {
      await creditAndroidPurchase(null, notification.sku, notification.purchaseToken);
    }
    // ONE_TIME_PRODUCT_CANCELED = 2 is a pending payment that never
    // completed — it was never credited, so there's nothing to undo.
  } catch (err) {
    logger.error({ err }, "Failed to process RTDN notification");
  }
});

// App Store Server Notifications V2. Set this URL in App Store Connect →
// App Information → App Store Server Notifications. The body is only used
// to learn which transaction changed; its state is then re-read from Apple's
// API, so a forged notification can't revoke anything.
webhookRouter.post("/billing/apple-notifications", async (req, res) => {
  res.status(200).end();

  try {
    const signedPayload = (req.body as { signedPayload?: string })?.signedPayload;
    if (!signedPayload) return;

    const notification = decodeJwsPayload<{ notificationType?: string; data?: { signedTransactionInfo?: string } }>(signedPayload);
    if (notification.notificationType !== "REFUND" || !notification.data?.signedTransactionInfo) return;

    const claimed = decodeJwsPayload<{ transactionId?: string }>(notification.data.signedTransactionInfo);
    if (!claimed.transactionId) return;

    const tx = await getAppStoreTransaction(claimed.transactionId);
    if (tx?.transactionId && tx.revocationDate) {
      await storage.revokeScanCredits(tx.transactionId);
    }
  } catch (err) {
    logger.error({ err }, "Failed to process App Store notification");
  }
});

export default router;
export { webhookRouter };
