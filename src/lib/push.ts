import { getMessaging } from "firebase-admin/messaging";
import { eq, inArray } from "drizzle-orm";
import { db, deviceTokensTable } from "../db";
import { firebaseApp } from "./firebaseAdmin";
import { logger } from "./logger";

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// Best-effort: a failed push never fails the request that triggered it.
export async function notifyUser(userId: string, title: string, body: string, data: Record<string, string> = {}) {
  try {
    const rows = await db.select().from(deviceTokensTable).where(eq(deviceTokensTable.userId, userId));
    if (!rows.length) return;
    const tokens = rows.map((r) => r.token);
    const result = await getMessaging(firebaseApp).sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: { priority: "high", notification: { channelId: "payments" } },
    });
    const dead = result.responses
      .map((r, i) => (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code) ? tokens[i] : null))
      .filter((t): t is string => !!t);
    if (dead.length) await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.token, dead));
  } catch (err) {
    logger.warn({ err, userId }, "Push notification failed");
  }
}
