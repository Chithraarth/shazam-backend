import { db } from "./db";
import { usersTable, scanPurchasesTable } from "./db";
import { eq, sql, isNull } from "drizzle-orm";

export class Storage {
  async getOrCreateUser(id: string, email?: string | null) {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (existing) return existing;
    const [created] = await db.insert(usersTable)
      .values({ id, email: email ?? null })
      .returning();
    return created;
  }

  async getUser(id: string) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }

  async updateUserPreferences(userId: string, prefs: { country: string; language: string; contentRegionsJson: string; onboardingComplete: boolean }) {
    const [user] = await db.update(usersTable)
      .set({ ...prefs, updatedAt: new Date() })
      .where(eq(usersTable.id, userId))
      .returning();
    return user;
  }

  // Atomic conditional decrement — the WHERE clause is checked by Postgres
  // itself, not read-then-written in JS, so two concurrent scan requests
  // can't both pass a stale "credits > 0" check and drive the count negative.
  // Returns the updated user, or null if there were no credits to spend.
  async decrementScanCredit(userId: string) {
    const [user] = await db.update(usersTable)
      .set({ scansRemaining: sql`${usersTable.scansRemaining} - 1`, updatedAt: new Date() })
      .where(sql`${usersTable.id} = ${userId} AND ${usersTable.scansRemaining} > 0`)
      .returning();
    return user ?? null;
  }

  // Idempotent: the unique constraint on purchaseToken means re-verifying
  // the same purchase (client retry, or both RTDN and the client reporting
  // it) can only ever grant credits once.
  async grantScanCredits(userId: string, productId: string, purchaseToken: string, scansGranted: number) {
    const inserted = await db.insert(scanPurchasesTable)
      .values({ userId, productId, purchaseToken, scansGranted })
      .onConflictDoNothing({ target: scanPurchasesTable.purchaseToken })
      .returning({ id: scanPurchasesTable.id });

    if (inserted.length > 0) {
      await db.update(usersTable)
        .set({ scansRemaining: sql`${usersTable.scansRemaining} + ${scansGranted}`, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    return user;
  }

  // Called when Play reports a purchase as voided/refunded — reverses
  // exactly the credits that specific purchase granted, and only once
  // (guarded by revokedAt), floored at zero so it can't push the count
  // negative if the user has already spent some of those credits.
  async revokeScanCredits(purchaseToken: string) {
    const [purchase] = await db.select().from(scanPurchasesTable)
      .where(eq(scanPurchasesTable.purchaseToken, purchaseToken));
    if (!purchase || purchase.revokedAt) return null;

    const [revoked] = await db.update(scanPurchasesTable)
      .set({ revokedAt: new Date() })
      .where(sql`${scanPurchasesTable.purchaseToken} = ${purchaseToken} AND ${isNull(scanPurchasesTable.revokedAt)}`)
      .returning();
    if (!revoked) return null;

    await db.update(usersTable)
      .set({
        scansRemaining: sql`GREATEST(${usersTable.scansRemaining} - ${purchase.scansGranted}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, purchase.userId));

    return purchase.userId;
  }
}

export const storage = new Storage();
