import { Router, type IRouter } from "express";
import { db } from "../db";
import { searchHistoryTable } from "../db";
import { DeleteHistoryParams } from "../schemas";
import { desc, eq, and, count, sql } from "drizzle-orm";

const router: IRouter = Router();

function getUserId(req: { userId?: string }): string | null {
  return (req as { userId?: string }).userId ?? null;
}

router.get("/history", async (req, res) => {
  const userId = getUserId(req as never);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const rows = await db
      .select({
        id: searchHistoryTable.id,
        createdAt: searchHistoryTable.createdAt,
        found: searchHistoryTable.found,
        confidence: searchHistoryTable.confidence,
        title: searchHistoryTable.title,
        type: searchHistoryTable.type,
        platform: searchHistoryTable.platform,
        thumbnailData: searchHistoryTable.thumbnailData,
      })
      .from(searchHistoryTable)
      .where(eq(searchHistoryTable.userId, userId))
      .orderBy(desc(searchHistoryTable.createdAt))
      .limit(50);

    res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch history");
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

router.delete("/history/:id", async (req, res) => {
  const userId = getUserId(req as never);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = DeleteHistoryParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const deleted = await db
      .delete(searchHistoryTable)
      .where(and(eq(searchHistoryTable.id, parsed.data.id), eq(searchHistoryTable.userId, userId)))
      .returning({ id: searchHistoryTable.id });

    if (deleted.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete history");
    res.status(500).json({ error: "Failed to delete history" });
  }
});

router.get("/stats", async (req, res) => {
  const userId = getUserId(req as never);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const [totalRow] = await db
      .select({ total: count() })
      .from(searchHistoryTable)
      .where(eq(searchHistoryTable.userId, userId));

    const [successRow] = await db
      .select({ total: count() })
      .from(searchHistoryTable)
      .where(and(eq(searchHistoryTable.userId, userId), eq(searchHistoryTable.found, true)));

    const totalSearches = totalRow?.total ?? 0;
    const successfulIdentifications = successRow?.total ?? 0;
    const successRate = totalSearches > 0 ? Math.round((successfulIdentifications / totalSearches) * 100) : 0;

    const platformRows = await db
      .select({
        platform: searchHistoryTable.platform,
        count: count(),
      })
      .from(searchHistoryTable)
      .where(
        sql`${searchHistoryTable.userId} = ${userId} AND ${searchHistoryTable.platform} IS NOT NULL AND ${searchHistoryTable.found} = true`,
      )
      .groupBy(searchHistoryTable.platform)
      .orderBy(desc(count()))
      .limit(5);

    const topPlatforms = platformRows
      .filter((r) => r.platform !== null)
      .map((r) => ({ platform: r.platform as string, count: r.count }));

    res.json({ totalSearches, successfulIdentifications, successRate, topPlatforms });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

export default router;
