import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { storage } from "../storage";

const router: IRouter = Router();

function parseRegions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function toProfile(user: {
  id: string;
  email: string | null;
  country: string | null;
  language: string | null;
  contentRegionsJson: string | null;
  onboardingComplete: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    country: user.country,
    language: user.language,
    contentRegions: parseRegions(user.contentRegionsJson),
    onboardingComplete: user.onboardingComplete,
  };
}

router.get("/user/me", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const user = await storage.getOrCreateUser(req.userId, req.userEmail);
  res.json(toProfile(user));
});

const PreferencesBody = z.object({
  country: z.string().min(1).max(100),
  language: z.string().min(1).max(100),
  contentRegions: z.array(z.string().min(1).max(60)).min(1).max(10),
});

router.put("/user/preferences", async (req: any, res) => {
  if (!req.userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = PreferencesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid preferences" }); return; }

  await storage.getOrCreateUser(req.userId, req.userEmail);
  const updated = await storage.updateUserPreferences(req.userId, {
    country: parsed.data.country,
    language: parsed.data.language,
    contentRegionsJson: JSON.stringify(parsed.data.contentRegions),
    onboardingComplete: true,
  });
  res.json(toProfile(updated));
});

export default router;
