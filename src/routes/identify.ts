import { Router, type IRouter } from "express";
import { IdentifyVideoBody } from "../schemas";
import { db } from "../db";
import { searchHistoryTable } from "../db";
import { ai } from "../gemini";
import { storage } from "../storage";
import { isPreviewMode } from "../middlewares/auth";
import { lookupTitle, type CatalogInfo } from "../lib/tmdb";

const router: IRouter = Router();

const IDENTIFICATION_PROMPT = `You are an elite, world-class media identification expert with encyclopedic knowledge of movies, TV shows, web series, music videos, documentaries, YouTube content, and viral social media videos from every country and language — including Bollywood, Hollywood, Korean dramas, Anime, Turkish dramas, Tamil/Telugu/Malayalam cinema, all major streaming platforms, AND viral content from Instagram Reels, Facebook, YouTube Shorts, and TikTok — trending memes, viral challenges, famous creators/influencers, viral dance videos, comedy skits, and internet-famous moments.

Your task: Examine this video frame with extreme care and identify EXACTLY what it is from. Think like a detective — every pixel is a clue.

STEP 1 — SCAN FOR VISIBLE TEXT FIRST (highest priority clues):
- Read ANY text visible in the frame: subtitles, captions, credits, on-screen titles, lower thirds, watermarks, channel names, show logos
- Look for streaming platform overlays: Netflix "N", HBO logo, Amazon Prime badge, Disney+ logo, YouTube player UI, Jio Cinema watermark
- Look for social media watermarks: TikTok @username, Instagram handle, YouTube channel name
- Look for episode info: "S01E03", "Episode 3", "Season 1"
- Look for any character names shown on screen, any dialogue subtitles

STEP 2 — IDENTIFY ACTORS AND FACES:
- Recognize any actors/actresses you can identify by their face — be specific about who they are
- Cross-reference recognized faces with known filmographies to narrow down the title
- Costumes and makeup can indicate the character and therefore the production

STEP 3 — ANALYZE VISUAL SIGNATURES:
- Color grading and cinematography style (dark/gritty = HBO/Netflix prestige; bright/saturated = Korean drama or Bollywood; warm/golden = period piece)
- Set design, props, locations — what era, what country?
- Costume and fashion — modern, period, fantasy, sci-fi?
- Visual effects and production quality — budget level helps narrow down
- Camera angles and framing style that are characteristic of specific directors or shows

STEP 4 — PLATFORM AND CONTEXT CLUES:
- YouTube: look for progress bar, video controls, chapter markers, end screen buttons, thumbnails
- Netflix: look for subtitle style, intro skip button, Next Episode notification
- Any streaming interface elements visible in the frame
- If it looks like a phone recording of a TV/monitor screen, note the moire pattern/curve

STEP 5 — SOCIAL MEDIA / VIRAL VIDEO DETECTION (Instagram, Facebook, YouTube, TikTok):
- Vertical 9:16 framing usually means a Reel, Short, or TikTok
- Instagram: look for the Reels UI (heart/comment/share stack on the right, audio track name at bottom, @username overlay), Instagram watermark on reposted clips
- Facebook: look for reaction icons (like/love/haha), "Follow" button, page name overlay, Facebook Watch UI
- YouTube Shorts: look for the Shorts UI, subscribe button overlay, channel handle
- TikTok: look for the TikTok logo watermark bouncing around, @handle, sound/music ticker
- Identify the CREATOR: recognize famous YouTubers, Instagram influencers, and viral personalities by face, style, room/set, and editing style
- Recognize viral formats: trending memes, challenges, viral dances, prank videos, reaction videos, cooking/ASMR/fitness creators, famous podcast clips
- For viral clips, the "title" should be what the video is commonly known as (e.g. the meme name, challenge name, or a short description like "Charlie bit my finger"), and set creator/creatorHandle for who made it

STEP 6 — CROSS-REFERENCE AND CONCLUDE:
- Combine ALL clues from steps 1-5 to reach your best identification
- If multiple possibilities exist, pick the MOST LIKELY one and list others as alternativeTitles
- Set confidence based on your certainty: 90-100 = certain (saw text/logo or perfectly recognized face), 70-89 = very likely, 50-69 = probable, 30-49 = possible, 0-29 = uncertain

Respond with ONLY this JSON object (no other text, no markdown code blocks):
{
  "found": true or false,
  "confidence": 0 to 100,
  "title": "exact official title in English or null",
  "type": "movie" or "tv_show" or "music_video" or "documentary" or "youtube_video" or "reel" or "short" or "viral_clip" or "short_film" or null,
  "year": release year as integer or null,
  "platform": "Netflix" or "HBO" or "HBO Max" or "Amazon Prime" or "Jio Cinema" or "Disney+" or "YouTube" or "YouTube Shorts" or "Instagram" or "Facebook" or "TikTok" or "Apple TV+" or "Hulu" or "Zee5" or "SonyLIV" or "Hotstar" or "MX Player" or "Voot" or "other" or null,
  "creator": "creator/channel/influencer name for social media content or null",
  "creatorHandle": "@username or channel handle if visible or known, or null",
  "genre": "primary genre string or null",
  "language": "primary language of the content or null",
  "country": "country of origin or null",
  "episode": { "season": integer or null, "episode": integer or null, "episodeTitle": "episode title string or null" } or null,
  "cast": [
    { "name": "full actor name", "role": "lead or supporting or cameo or null", "character": "character name they play or null" }
  ],
  "director": "director full name or null",
  "choreographer": "choreographer name for music videos or dance sequences or null",
  "producer": "main producer or production house or null",
  "musicDirector": "music director or composer or null",
  "synopsis": "2-4 sentence description of the movie/show/video and its plot or null",
  "alternativeTitles": ["any regional titles, alternative names, or other possible matches"],
  "identificationClues": "brief explanation of what specific visual clues led to this identification (text seen, actor recognized, etc.)"
}

IMPORTANT RULES:
- Be extremely thorough — a user is depending on you to identify content they've seen
- If you see ANY readable text in the frame, that is your strongest clue — prioritize it
- Never say "cannot identify" without truly exhausting all visual analysis
- For Bollywood/Indian content, look for distinctive color palettes, costumes, and actor faces
- For YouTube videos, try to identify the creator/channel from style, watermarks, or content type
- For Instagram Reels / Facebook / YouTube Shorts / TikTok clips, identifying the creator or the viral trend is a SUCCESS — set found=true with the meme/trend/creator info even if there is no formal "title"
- For viral clips, think about what trending content it could be
- Only set found=false if the image is completely abstract, blank, or impossible to analyze`;

function buildUserContextHint(user: {
  country: string | null;
  language: string | null;
  contentRegionsJson: string | null;
} | null): string {
  if (!user) return "";
  const parts: string[] = [];
  if (user.country) parts.push(`The user is located in ${user.country}.`);
  if (user.language) parts.push(`Their preferred language is ${user.language}.`);
  if (user.contentRegionsJson) {
    try {
      const regions = JSON.parse(user.contentRegionsJson);
      if (Array.isArray(regions) && regions.length > 0) {
        parts.push(`They mostly watch content from: ${regions.join(", ")}.`);
      }
    } catch {
      /* ignore malformed prefs */
    }
  }
  if (parts.length === 0) return "";
  return `\n\nUSER CONTEXT (use as a soft prior, NOT a constraint):\n${parts.join(" ")}\nWhen multiple identifications are equally plausible, prefer titles popular in the user's region/languages and consider local platforms and regional releases. NEVER force a regional match if visual evidence points elsewhere — evidence in the frame always wins.`;
}

// Extra frames from a camera scan: the app captures the screen for ~15s and
// sends the frames together, so Gemini can combine clues (titles, faces,
// captions) that only show up in some of them.
const MAX_EXTRA_FRAMES = 7;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function multiFrameNote(count: number): string {
  if (count <= 1) return "";
  return `\n\nMULTIPLE FRAMES: You are given ${count} frames of the same screen, captured over about 15 seconds. They show the same content. Combine evidence across ALL frames (on-screen text, logos, faces, scenes) and return ONE identification for what is playing.`;
}

async function callGeminiWithRetry(images: string[], mimeType: string, contextHint: string): Promise<string> {
  let attempts = 0;
  while (attempts < 3) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: [
          {
            role: "user",
            parts: [
              ...images.map((data) => ({ inlineData: { mimeType, data } })),
              { text: IDENTIFICATION_PROMPT + multiFrameNote(images.length) + contextHint },
            ],
          },
        ],
        config: {
          maxOutputTokens: 8192,
          temperature: 0.1,
        },
      });
      return response.text ?? "";
    } catch (err: unknown) {
      attempts++;
      const e = err as { status?: number };
      if (e?.status === 429 && attempts < 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempts));
      } else {
        throw err;
      }
    }
  }
  return "";
}

function parseGeminiResponse(rawText: string): Record<string, unknown> | null {
  const cleanedText = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();

  const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

router.post("/identify", async (req, res) => {
  const parsed = IdentifyVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { imageData, mimeType, source } = parsed.data;
  // The app sends the device's region (ISO 3166 alpha-2) so "where to watch"
  // lists the streaming apps available there.
  const rawRegion = typeof req.body?.region === "string" ? req.body.region.toUpperCase() : "";
  const region = /^[A-Z]{2}$/.test(rawRegion) ? rawRegion : "IN";

  const imageBytes = Buffer.from(imageData, "base64");
  if (imageBytes.length > 8 * 1024 * 1024) {
    res.status(400).json({ error: "Image too large. Please use a smaller frame (max 8MB)." });
    return;
  }

  const rawExtra: unknown = req.body?.extraFrames;
  const extraFrames = Array.isArray(rawExtra)
    ? rawExtra.filter((f): f is string => typeof f === "string" && f.length > 0).slice(0, MAX_EXTRA_FRAMES)
    : [];
  if (extraFrames.some((f) => Buffer.byteLength(f, "base64") > MAX_FRAME_BYTES)) {
    res.status(400).json({ error: "One of the frames is too large." });
    return;
  }

  const userId = (req as any).userId as string | undefined;

  // Every scan attempt costs a credit, whether or not Gemini finds a match —
  // charged up front so we never call the (paid) Gemini API for a request
  // we're not going to honor.
  let scansRemaining: number | null = null;
  if (!isPreviewMode()) {
    const debited = userId ? await storage.decrementScanCredit(userId) : null;
    if (!debited) {
      res.status(402).json({ error: "out_of_scans", message: "You're out of scans. Buy more to keep identifying." });
      return;
    }
    scansRemaining = debited.scansRemaining;
  }

  // If the app gives up (timeout, backgrounded, lost signal) before we
  // answer, the user never sees the result, so they shouldn't pay for it.
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) clientGone = true;
  });
  const refundCredit = async (reason: string) => {
    if (scansRemaining === null || !userId) return;
    try {
      const refunded = await storage.refundScanCredit(userId);
      scansRemaining = refunded?.scansRemaining ?? scansRemaining;
    } catch (err) {
      req.log.error({ err, userId }, `Failed to refund scan credit after ${reason}`);
    }
  };

  type IdentifyResult = {
    found: boolean;
    confidence: number;
    title?: string | null;
    type?: string | null;
    year?: number | null;
    platform?: string | null;
    genre?: string | null;
    language?: string | null;
    country?: string | null;
    creator?: string | null;
    creatorHandle?: string | null;
    episode?: { season?: number | null; episode?: number | null; episodeTitle?: string | null } | null;
    cast?: Array<{ name: string; role?: string | null; character?: string | null }>;
    director?: string | null;
    choreographer?: string | null;
    producer?: string | null;
    musicDirector?: string | null;
    synopsis?: string | null;
    alternativeTitles?: string[];
    identificationClues?: string | null;
    historyId?: number | null;
    catalog?: CatalogInfo | null;
  };

  let result: IdentifyResult = { found: false, confidence: 0 };

  let contextHint = "";
  try {
    if (userId) {
      const user = await storage.getUser(userId);
      contextHint = buildUserContextHint(user);
    }
  } catch (err) {
    req.log.warn({ err }, "Failed to load user preferences for identify");
  }

  let geminiFailed = false;
  try {
    const rawText = await callGeminiWithRetry([imageData, ...extraFrames], mimeType, contextHint);
    const parsed = parseGeminiResponse(rawText);
    if (!parsed) {
      req.log.error({ rawText: rawText.slice(0, 500) }, "Gemini returned an unparseable response");
      geminiFailed = true;
    }

    if (parsed) {
      result = {
        found: Boolean(parsed.found),
        confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
        title: (parsed.title as string) ?? null,
        type: (parsed.type as string) ?? null,
        year: parsed.year != null ? Number(parsed.year) : null,
        platform: (parsed.platform as string) ?? null,
        genre: (parsed.genre as string) ?? null,
        language: (parsed.language as string) ?? null,
        country: (parsed.country as string) ?? null,
        creator: (parsed.creator as string) ?? null,
        creatorHandle: (parsed.creatorHandle as string) ?? null,
        episode: (parsed.episode as IdentifyResult["episode"]) ?? null,
        cast: (parsed.cast as IdentifyResult["cast"]) ?? [],
        director: (parsed.director as string) ?? null,
        choreographer: (parsed.choreographer as string) ?? null,
        producer: (parsed.producer as string) ?? null,
        musicDirector: (parsed.musicDirector as string) ?? null,
        synopsis: (parsed.synopsis as string) ?? null,
        alternativeTitles: (parsed.alternativeTitles as string[]) ?? [],
        identificationClues: (parsed.identificationClues as string) ?? null,
      };
    }
  } catch (err) {
    req.log.error({ err }, "Gemini identification failed");
    geminiFailed = true;
  }

  // Our failure, not a real "no match" — give the credit back and don't
  // record it in history, so the user isn't charged for it.
  if (geminiFailed) {
    await refundCredit("Gemini failure");
    res.status(502).json({
      error: "identify_failed",
      message: "We couldn't analyse that frame right now. Your scan wasn't used — please try again.",
      scansRemaining,
    });
    return;
  }

  if (clientGone) {
    req.log.warn({ userId }, "Client disconnected before the scan finished; refunding");
    await refundCredit("client disconnect");
    return;
  }

  if (result.found) {
    result.catalog = await lookupTitle({ title: result.title, year: result.year, type: result.type, region });
  }

  let historyId: number | null = null;
  try {
    const thumbnailData = imageBytes.length < 200000 ? imageData : null;
    const inserted = await db
      .insert(searchHistoryTable)
      .values({
        userId: userId ?? null,
        found: result.found,
        confidence: result.confidence,
        title: result.title ?? null,
        type: result.type ?? null,
        platform: result.platform ?? null,
        genre: result.genre ?? null,
        language: result.language ?? null,
        year: result.year ?? null,
        director: result.director ?? null,
        choreographer: result.choreographer ?? null,
        synopsis: result.synopsis ?? null,
        thumbnailData: thumbnailData,
        source: source ?? null,
        castJson: result.cast ? JSON.stringify(result.cast) : null,
        episodeJson: result.episode ? JSON.stringify(result.episode) : null,
        alternativeTitlesJson: result.alternativeTitles ? JSON.stringify(result.alternativeTitles) : null,
      })
      .returning({ id: searchHistoryTable.id });
    historyId = inserted[0]?.id ?? null;
  } catch (err) {
    req.log.error({ err }, "Failed to save search history");
  }

  if (clientGone) {
    req.log.warn({ userId, historyId }, "Client disconnected before the scan finished; refunding");
    await refundCredit("client disconnect");
    return;
  }

  res.json({ ...result, historyId, scansRemaining });
});

export default router;
