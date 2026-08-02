import { Router, type IRouter } from "express";
import { storage } from "../storage";
import { getUncachableStripeClient } from "../stripeClient";

const router: IRouter = Router();

router.get("/stripe/price", async (_req, res) => {
  const price = await storage.getYearlyPrice();
  if (!price) { res.status(404).json({ error: "Yearly price not found — run the seed script first." }); return; }
  res.json({ data: price });
});

router.post("/stripe/checkout", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await storage.getOrCreateUser(req.userId, req.userEmail);

  if (user.hasActiveSubscription) { res.status(400).json({ error: "You already have an active subscription." }); return; }

  const priceData = await storage.getYearlyPrice();
  if (!priceData) { res.status(404).json({ error: "Yearly price not found. Please run the seed script." }); return; }

  const stripe = await getUncachableStripeClient();

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { userId: user.id },
    });
    await storage.updateUserStripeInfo(user.id, { stripeCustomerId: customer.id });
    customerId = customer.id;
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const basePath = process.env.BASE_PATH?.replace(/\/$/, "") ?? "";

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: priceData.id as string, quantity: 1 }],
    mode: "subscription",
    adaptive_pricing: { enabled: true },
    success_url: `${origin}${basePath}/?checkout=success`,
    cancel_url: `${origin}${basePath}/purchase`,
    metadata: { userId: user.id },
    subscription_data: { metadata: { userId: user.id } },
  });

  res.json({ url: session.url });
});

export default router;
