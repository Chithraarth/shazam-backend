import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { storage } from "../storage";
import {
  verifySubscriptionPurchase,
  acknowledgeSubscriptionPurchase,
  type SubscriptionStatus,
} from "../lib/googlePlay";

// Needs requireAuth — mount under the authenticated section.
const router: IRouter = Router();
// Public: Pub/Sub push calls this directly, with no Firebase auth token.
// Secured instead by the shared-secret query param — mount before requireAuth.
const webhookRouter: IRouter = Router();

const VerifyBody = z.object({
  purchaseToken: z.string().min(1),
  productId: z.string().min(1),
});

// Applies a verified Play subscription status to a user row. Shared by both
// the client-triggered verify call and the RTDN webhook so the two paths
// can't drift into different update logic.
async function applySubscriptionStatus(userId: string, purchaseToken: string, status: SubscriptionStatus) {
  return storage.updateUserSubscription(userId, {
    hasActiveSubscription: status.isActive,
    playProductId: status.productId,
    playPurchaseToken: purchaseToken,
    subscriptionExpiryAt: status.expiryTimeMillis ? new Date(status.expiryTimeMillis) : null,
  });
}

router.post("/billing/verify", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body" }); return; }
  const { purchaseToken, productId } = parsed.data;

  try {
    const status = await verifySubscriptionPurchase(purchaseToken);

    if (!status.isActive) {
      res.status(400).json({ error: "This purchase isn't active." });
      return;
    }

    // The purchase was made with obfuscatedAccountId set to the buyer's
    // Firebase UID (see mobile purchase flow) — reject a token that doesn't
    // belong to the signed-in user, so one account's purchase can't be
    // replayed onto another.
    if (status.obfuscatedExternalAccountId && status.obfuscatedExternalAccountId !== req.userId) {
      res.status(403).json({ error: "This purchase belongs to a different account." });
      return;
    }

    if (status.acknowledgementState !== "acknowledged") {
      await acknowledgeSubscriptionPurchase(productId, purchaseToken);
    }

    const user = await applySubscriptionStatus(req.userId, purchaseToken, status);
    res.json({ hasActiveSubscription: user.hasActiveSubscription, expiryTimeMillis: status.expiryTimeMillis });
  } catch (err) {
    req.log.error({ err }, "Failed to verify Play purchase");
    res.status(500).json({ error: "Failed to verify purchase" });
  }
});

// Pub/Sub push endpoint for Real-time Developer Notifications. Configure the
// push subscription's endpoint URL as .../api/billing/rtdn?token=<RTDN_WEBHOOK_SECRET>
// so we can confirm the request actually came from our own Pub/Sub subscription.
webhookRouter.post("/billing/rtdn", async (req, res) => {
  const expectedSecret = process.env.RTDN_WEBHOOK_SECRET;
  if (!expectedSecret || req.query.token !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Ack immediately — Pub/Sub retries on anything but a 2xx, and we don't
  // want a slow/failed Play API call to cause redelivery storms. Errors are
  // logged for follow-up rather than surfaced to Pub/Sub.
  res.status(204).end();

  try {
    const messageData = (req.body as { message?: { data?: string } })?.message?.data;
    if (!messageData) return;

    const decoded = JSON.parse(Buffer.from(messageData, "base64").toString("utf8")) as {
      subscriptionNotification?: { purchaseToken?: string };
    };
    const purchaseToken = decoded.subscriptionNotification?.purchaseToken;
    if (!purchaseToken) return;

    const status = await verifySubscriptionPurchase(purchaseToken);

    const userId = status.obfuscatedExternalAccountId
      ?? (await storage.getUserByPlayPurchaseToken(purchaseToken))?.id
      ?? null;
    if (!userId) {
      req.log.warn({ purchaseToken }, "RTDN notification for unknown user");
      return;
    }

    await applySubscriptionStatus(userId, purchaseToken, status);
  } catch (err) {
    req.log.error({ err }, "Failed to process RTDN notification");
  }
});

export default router;
export { webhookRouter };
