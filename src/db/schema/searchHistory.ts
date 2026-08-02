import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const searchHistoryTable = pgTable("search_history", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  found: boolean("found").notNull().default(false),
  confidence: integer("confidence").notNull().default(0),
  title: text("title"),
  type: text("type"),
  platform: text("platform"),
  genre: text("genre"),
  language: text("language"),
  year: integer("year"),
  director: text("director"),
  choreographer: text("choreographer"),
  synopsis: text("synopsis"),
  thumbnailData: text("thumbnail_data"),
  source: text("source"),
  castJson: text("cast_json"),
  episodeJson: text("episode_json"),
  alternativeTitlesJson: text("alternative_titles_json"),
});

export const insertSearchHistorySchema = createInsertSchema(searchHistoryTable).omit({ id: true, createdAt: true });
export type InsertSearchHistory = z.infer<typeof insertSearchHistorySchema>;
export type SearchHistory = typeof searchHistoryTable.$inferSelect;
