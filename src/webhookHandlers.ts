import { db } from "./db";
import { usersTable } from "./db";
import { eq } from "drizzle-orm";
import { getStripeSync } from "./stripeClient";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    try {
      const event = JSON.parse(payload.toString()) as { type: string; data: { object: any } };

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId = session.metadata?.userId as string | undefined;
        if (userId && (session.payment_status === "paid" || session.status === "complete")) {
          await db
            .update(usersTable)
            .set({
              hasActiveSubscription: true,
              stripeCustomerId: session.customer ?? undefined,
              stripeSubscriptionId: session.subscription ?? undefined,
              updatedAt: new Date(),
            })
            .where(eq(usersTable.id, userId));
        }
      }

      if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const subscription = event.data.object;
        const subscriptionId = subscription.id as string;
        const isActive =
          event.type !== "customer.subscription.deleted" &&
          (subscription.status === "active" || subscription.status === "trialing");

        const updated = await db
          .update(usersTable)
          .set({
            hasActiveSubscription: isActive,
            stripeSubscriptionId: subscriptionId,
            updatedAt: new Date(),
          })
          .where(eq(usersTable.stripeSubscriptionId, subscriptionId))
          .returning({ id: usersTable.id });

        if (updated.length === 0) {
          const fallbackUserId = subscription.metadata?.userId as string | undefined;
          const customerId = subscription.customer as string | undefined;
          if (fallbackUserId) {
            await db
              .update(usersTable)
              .set({
                hasActiveSubscription: isActive,
                stripeSubscriptionId: subscriptionId,
                updatedAt: new Date(),
              })
              .where(eq(usersTable.id, fallbackUserId));
          } else if (customerId) {
            await db
              .update(usersTable)
              .set({
                hasActiveSubscription: isActive,
                stripeSubscriptionId: subscriptionId,
                updatedAt: new Date(),
              })
              .where(eq(usersTable.stripeCustomerId, customerId));
          }
        }
      }
    } catch {
    }
  }
}
