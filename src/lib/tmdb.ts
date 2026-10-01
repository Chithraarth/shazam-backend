import { logger } from "./logger";

// TMDB adds what Gemini can't: artwork, cast photos, episode lists and where
// to watch (TMDB's watch-provider data comes from JustWatch, which must be
// credited in the app). Every call is best-effort — identification never
// fails because TMDB is slow or down.

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 500;

export function tmdbEnabled(): boolean {
  return !!process.env.TMDB_API_KEY;
}

const cache = new Map<string, { at: number; value: unknown }>();

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  // A v4 "read access token" is a long JWT; a v3 key is a short hex string.
  const bearer = key.length > 40;
  if (!bearer) url.searchParams.set("api_key", key);

  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: bearer ? { Authorization: `Bearer ${key}`, Accept: "application/json" } : { Accept: "application/json" },
    });
    if (!res.ok) {
      if (res.status !== 404) logger.warn({ status: res.status, path }, "TMDB request failed");
      return null;
    }
    const value = (await res.json()) as T;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn({ err, path }, "TMDB request error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const img = (size: string, path?: string | null) => (path ? `${IMG}/${size}${path}` : null);
const yearOf = (date?: string | null) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

export type CatalogPerson = { id: number; name: string; character: string | null; profileUrl: string | null };
export type Provider = { id: number; name: string; logoUrl: string | null };
export type CatalogInfo = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  runtimeMinutes: number | null;
  seasons: number | null;
  cast: CatalogPerson[];
  trailerKey: string | null;
  watch: { region: string; link: string | null; stream: Provider[]; rent: Provider[]; buy: Provider[] } | null;
};

type SearchHit = { id: number; media_type?: string; title?: string; name?: string; release_date?: string; first_air_date?: string; popularity?: number };
type Credit = { id: number; name: string; character?: string; roles?: { character?: string }[]; profile_path?: string | null; order?: number };
type ProviderRow = { provider_id: number; provider_name: string; logo_path?: string | null };
type Details = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number;
  credits?: { cast?: Credit[] };
  aggregate_credits?: { cast?: Credit[] };
  videos?: { results?: { site: string; type: string; key: string; official?: boolean }[] };
  "watch/providers"?: { results?: Record<string, { link?: string; flatrate?: ProviderRow[]; rent?: ProviderRow[]; buy?: ProviderRow[] }> };
};

const MOVIE_TYPES = new Set(["movie", "short_film", "documentary"]);

async function search(title: string, year: number | null, type: string | null): Promise<{ id: number; mediaType: "movie" | "tv" } | null> {
  const wantTv = type === "tv_show";
  const wantMovie = type ? MOVIE_TYPES.has(type) : false;
  if (wantTv || wantMovie) {
    const path = wantTv ? "/search/tv" : "/search/movie";
    const yearParam = wantTv ? { first_air_date_year: year ?? undefined } : { year: year ?? undefined };
    let res = await get<{ results: SearchHit[] }>(path, { query: title, ...yearParam });
    if (!res?.results?.length && year) res = await get<{ results: SearchHit[] }>(path, { query: title });
    const hit = res?.results?.[0];
    if (hit) return { id: hit.id, mediaType: wantTv ? "tv" : "movie" };
  }
  const multi = await get<{ results: SearchHit[] }>("/search/multi", { query: title });
  const hit = multi?.results?.find((r) => r.media_type === "movie" || r.media_type === "tv");
  return hit ? { id: hit.id, mediaType: hit.media_type as "movie" | "tv" } : null;
}

const providers = (rows?: ProviderRow[]): Provider[] =>
  (rows ?? []).slice(0, 6).map((p) => ({ id: p.provider_id, name: p.provider_name, logoUrl: img("w92", p.logo_path) }));

// Looks the identified title up on TMDB. Returns null for clips/Reels (not
// in TMDB), when TMDB isn't configured, or when nothing matches.
export async function lookupTitle(opts: { title: string | null | undefined; year?: number | null; type?: string | null; region: string }): Promise<CatalogInfo | null> {
  if (!tmdbEnabled() || !opts.title) return null;
  const type = opts.type ?? null;
  if (type && !MOVIE_TYPES.has(type) && type !== "tv_show") return null;

  const found = await search(opts.title, opts.year ?? null, type);
  if (!found) return null;

  const extra = found.mediaType === "tv" ? "aggregate_credits,videos,watch/providers" : "credits,videos,watch/providers";
  const d = await get<Details>(`/${found.mediaType}/${found.id}`, { append_to_response: extra });
  if (!d) return null;

  const castRows = (found.mediaType === "tv" ? d.aggregate_credits?.cast : d.credits?.cast) ?? [];
  const trailer =
    d.videos?.results?.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ??
    d.videos?.results?.find((v) => v.site === "YouTube" && v.type === "Trailer");
  const region = d["watch/providers"]?.results?.[opts.region];

  return {
    tmdbId: d.id,
    mediaType: found.mediaType,
    title: d.title ?? d.name ?? opts.title,
    year: yearOf(d.release_date ?? d.first_air_date),
    posterUrl: img("w500", d.poster_path),
    backdropUrl: img("w780", d.backdrop_path),
    runtimeMinutes: d.runtime ?? d.episode_run_time?.[0] ?? null,
    seasons: d.number_of_seasons ?? null,
    cast: castRows.slice(0, 12).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character ?? c.roles?.[0]?.character ?? null,
      profileUrl: img("w185", c.profile_path),
    })),
    trailerKey: trailer?.key ?? null,
    watch: region
      ? { region: opts.region, link: region.link ?? null, stream: providers(region.flatrate), rent: providers(region.rent), buy: providers(region.buy) }
      : null,
  };
}

export type PersonInfo = {
  id: number;
  name: string;
  profileUrl: string | null;
  knownFor: { id: number; mediaType: "movie" | "tv"; title: string; year: number | null; posterUrl: string | null; character: string | null }[];
};

export async function lookupPerson(id: number): Promise<PersonInfo | null> {
  type Combined = { cast?: (SearchHit & { poster_path?: string | null; character?: string; vote_count?: number })[] };
  const d = await get<{ id: number; name: string; profile_path?: string | null; combined_credits?: Combined }>(`/person/${id}`, { append_to_response: "combined_credits" });
  if (!d) return null;
  const seen = new Set<string>();
  const knownFor = (d.combined_credits?.cast ?? [])
    .filter((c) => (c.media_type === "movie" || c.media_type === "tv") && c.poster_path)
    .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
    .filter((c) => {
      const k = `${c.media_type}:${c.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 12)
    .map((c) => ({
      id: c.id,
      mediaType: c.media_type as "movie" | "tv",
      title: c.title ?? c.name ?? "",
      year: yearOf(c.release_date ?? c.first_air_date),
      posterUrl: img("w342", c.poster_path),
      character: c.character || null,
    }));
  return { id: d.id, name: d.name, profileUrl: img("h632", d.profile_path), knownFor };
}

export type SeasonInfo = {
  season: number;
  episodes: { number: number; name: string; overview: string | null; airDate: string | null; runtime: number | null; stillUrl: string | null }[];
};

export async function lookupSeason(tvId: number, season: number): Promise<SeasonInfo | null> {
  type Ep = { episode_number: number; name: string; overview?: string; air_date?: string; runtime?: number | null; still_path?: string | null };
  const d = await get<{ season_number: number; episodes?: Ep[] }>(`/tv/${tvId}/season/${season}`);
  if (!d) return null;
  return {
    season: d.season_number,
    episodes: (d.episodes ?? []).map((e) => ({
      number: e.episode_number,
      name: e.name,
      overview: e.overview || null,
      airDate: e.air_date || null,
      runtime: e.runtime ?? null,
      stillUrl: img("w300", e.still_path),
    })),
  };
}
