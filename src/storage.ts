import { db } from "./db";
import { usersTable } from "./db";
import { eq } from "drizzle-orm";

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
}

export const storage = new Storage();
