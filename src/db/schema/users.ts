import { pgTable, text, boolean, integer, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// New users start with a handful of free scans so they can try the app
// before ever needing to buy a scan pack.
export const FREE_SCAN_CREDITS = 5;

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  scansRemaining: integer("scans_remaining").default(FREE_SCAN_CREDITS).notNull(),
  country: text("country"),
  language: text("language"),
  contentRegionsJson: text("content_regions_json"),
  onboardingComplete: boolean("onboarding_complete").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// One row per verified Play purchase. The unique constraint on
// purchaseToken is what makes crediting idempotent — verifying the same
// purchase twice (client retry, RTDN + client both reporting it) can only
// ever grant credits once.
export const scanPurchasesTable = pgTable("scan_purchases", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull(),
  purchaseToken: text("purchase_token").notNull().unique(),
  scansGranted: integer("scans_granted").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
