import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { storage } from "../storage";
import {
  verifyProductPurchase,
  acknowledgeProductPurchase,
  consumeProductPurchase,
} from "../lib/googlePlay";

// Needs requireAuth — mount under the authenticated section.
const router: IRouter = Router();
// Public: Pub/Sub push calls this directly, with no Firebase auth token.
// Secured instead by the shared-secret query param — mount before requireAuth.
const webhookRouter: IRouter = Router();

// Maps each one-time product SKU to how many scan credits it grants. Add an
// entry here for every consumable product created in Play Console.
const SCAN_PACKS: Record<string, number> = {
  scan_pack_50: 50,
};

const VerifyBody = z.object({
  purchaseToken: z.string().min(1),
  productId: z.string().min(1),
});

router.post("/billing/verify", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request body" }); return; }
  const { purchaseToken, productId } = parsed.data;

  const scansGranted = SCAN_PACKS[productId];
  if (!scansGranted) { res.status(400).json({ error: "Unknown product" }); return; }

  try {
    const status = await verifyProductPurchase(productId, purchaseToken);

    if (!status.isPurchased) {
      res.status(400).json({ error: "This purchase isn't valid." });
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
      await acknowledgeProductPurchase(productId, purchaseToken);
    }

    // grantScanCredits is idempotent (unique purchaseToken constraint), so
    // it's safe even if the client retries this call.
    const user = await storage.grantScanCredits(req.userId, productId, purchaseToken, scansGranted);

    if (!status.alreadyConsumed) {
      await consumeProductPurchase(productId, purchaseToken);
    }

    res.json({ scansRemaining: user.scansRemaining });
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
      oneTimeProductNotification?: {
        notificationType?: number;
        purchaseToken?: string;
        sku?: string;
      };
    };
    const notification = decoded.oneTimeProductNotification;
    const purchaseToken = notification?.purchaseToken;
    if (!purchaseToken) return;

    // ONE_TIME_PRODUCT_CANCELED = 2 (refunded/voided). We only react to
    // voids here — a fresh purchase is credited via the client's own
    // /billing/verify call, which has the signed-in user's context that
    // this webhook doesn't.
    if (notification?.notificationType === 2) {
      await storage.revokeScanCredits(purchaseToken);
    }
  } catch (err) {
    req.log.error({ err }, "Failed to process RTDN notification");
  }
});

export default router;
export { webhookRouter };
