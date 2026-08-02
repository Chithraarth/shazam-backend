import { db } from "./db";
import { usersTable } from "./db";
import { eq, sql } from "drizzle-orm";

export class Storage {
  async getOrCreateUser(id: string, email?: string | null) {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (existing) return existing;
    const [created] = await db.insert(usersTable)
      .values({ id, email: email ?? null, hasActiveSubscription: false })
      .returning();
    return created;
  }

  async getUser(id: string) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }

  async updateUserStripeInfo(userId: string, info: { stripeCustomerId?: string; hasActiveSubscription?: boolean; stripeSubscriptionId?: string; stripePaymentIntentId?: string; updatedAt?: Date }) {
    const [user] = await db.update(usersTable)
      .set({ ...info, updatedAt: new Date() })
      .where(eq(usersTable.id, userId))
      .returning();
    return user;
  }

  async updateUserPreferences(userId: string, prefs: { country: string; language: string; contentRegionsJson: string; onboardingComplete: boolean }) {
    const [user] = await db.update(usersTable)
      .set({ ...prefs, updatedAt: new Date() })
      .where(eq(usersTable.id, userId))
      .returning();
    return user;
  }

  async getYearlyPrice() {
    try {
      const result = await db.execute(sql`
        SELECT pr.id, pr.unit_amount, pr.currency, pr.recurring, p.name, p.description
        FROM stripe.prices pr
        JOIN stripe.products p ON pr.product = p.id
        WHERE p.name = 'Videofy Yearly'
        AND pr.active = true
        AND pr.recurring->>'interval' = 'year'
        ORDER BY pr.created DESC
        LIMIT 1
      `);
      return result.rows[0] ?? null;
    } catch {
      return null;
    }
  }
}

export const storage = new Storage();
