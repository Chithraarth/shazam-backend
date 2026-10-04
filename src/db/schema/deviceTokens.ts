import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// FCM registration tokens, one row per app install, for payment notifications.
export const deviceTokensTable = pgTable("device_tokens", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").notNull().unique(),
  platform: text("platform").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
