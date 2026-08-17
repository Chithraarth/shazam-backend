import { getAuth } from "firebase-admin/auth";
import { firebaseApp } from "../lib/firebaseAdmin";
import { logger } from "../lib/logger";

export const isPreviewMode = (): boolean =>
  process.env.NODE_ENV !== "production" && process.env.PREVIEW_MODE !== "false";

function extractBearerToken(req: any): string | null {
  const header = req.headers?.authorization as string | undefined;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export const requireAuth = async (req: any, res: any, next: any): Promise<void> => {
  const token = extractBearerToken(req);
  if (!token) {
    if (isPreviewMode()) {
      req.userId = "preview-user";
      req.userEmail = "preview@videofy.test";
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const decoded = await getAuth(firebaseApp).verifyIdToken(token);
    req.userId = decoded.uid;
    req.userEmail = decoded.email ?? null;
    next();
  } catch (err) {
    logger.warn({ err }, "ID token verification failed");
    if (isPreviewMode()) {
      req.userId = "preview-user";
      req.userEmail = "preview@videofy.test";
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  }
};
