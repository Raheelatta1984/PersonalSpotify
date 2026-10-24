/**
 * Unified web-music search: mp3juice.sc first, then the wider web.
 *
 *   query ─► mp3juice.sc scrape ── hits? ─► return (metadata + real song URLs)
 *                    │ no / too few
 *                    ▼
 *              Google CSE ─► DuckDuckGo ─► iTunes catalogue
 *                    │
 *                    └─ nothing at all ─► clearly-labelled offline demo rows
 *
 * The result rows are metadata only; playback resolution happens when the user
 * presses play (`/api/web/play`) so a search stays fast.
 */

import type { WebSearchHit, WebSearchOutcome } from "../types";
import { normalizeForMatch } from "./html";
import { searchMp3Juice, type FetchLike } from "./mp3juice";
import { cleanSearchTitle, googleConfigured, searchDuckDuckGo, searchGoogle, searchItunesMetadata } from "./websearch";
import { offlineResults } from "./sources";

export interface WebSearchOptions {
  limit?: number;
  fetchImpl?: FetchLike;
  /** false = mp3juice.sc only (used by tests and the "site only" toggle). */
  allowFallback?: boolean;
  /** Use the in-process 60 s cache (default true). */
  cache?: boolean;
}

interface CacheEntry {
  at: number;
  outcome: WebSearchOutcome;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 40;

const cacheRoot = globalThis as unknown as { __songhubWebSearch?: Map<string, CacheEntry> };
const searchCache: Map<string, CacheEntry> = (cacheRoot.__songhubWebSearch ??= new Map());

function readCache(key: string): WebSearchOutcome | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.outcome;
}

function writeCache(key: string, outcome: WebSearchOutcome): void {
  if (searchCache.size >= CACHE_MAX) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) searchCache.delete(oldest[0]);
  }
  searchCache.set(key, { at: Date.now(), outcome });
}

/** Drop cached searches (used by tests and after a failed run). */
export function clearWebSearchCache(): void {
  searchCache.clear();
}

/** Map an mp3juice row onto the shared hit shape. */
function fromMp3Juice(
  hits: Awaited<ReturnType<typeof searchMp3Juice>>["hits"],
): WebSearchHit[] {
  return hits.map((hit, index) => ({
    id: hit.id,
    title: hit.title,
    artist: hit.artist,
    album: hit.album,
    durationSec: hit.durationSec,
    artworkUrl: hit.artworkUrl,
    sourceUrl: hit.pageUrl,
    provider: "mp3juice",
    providerLabel: "mp3juice.sc",
    confidence: Math.max(0.45, 0.95 - index * 0.03),
    notes: hit.durationSec ? undefined : "Duration not listed on the site",
  }));
}

function dedupe(hits: WebSearchHit[], limit: number): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const hit of [...hits].sort((a, b) => b.confidence - a.confidence)) {
    const key = `${normalizeForMatch(hit.title)}|${normalizeForMatch(hit.artist)}`;
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/** Offline demo rows so the view still works with no internet at all. */
export function offlineWebHits(query: string, limit = 8): WebSearchHit[] {
  return offlineResults(query, limit).map((result, index) => ({
    id: `songhub-demo:${result.id}`,
    title: result.title,
    artist: result.artist,
    album: result.album,
    durationSec: result.durationSec,
    sourceUrl: result.sourceUrl,
    provider: "songhub-demo",
    providerLabel: "SongHub demo",
    confidence: Math.max(0.3, 0.8 - index * 0.04),
    notes: "Offline demo row — live web search was unavailable.",
  }));
}

export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<WebSearchOutcome> {
  const started = performance.now();
  const trimmed = query.trim();
  const limit = Math.max(1, Math.min(24, options.limit ?? 12));
  const allowFallback = options.allowFallback ?? true;

  if (!trimmed) {
    return {
      query,
      hits: [],
      providers: [],
      live: false,
      fallbackUsed: false,
      tookMs: 0,
      notice: "Type a song, an artist, or a lyric to search mp3juice.sc.",
    };
  }

  const cacheKey = `${trimmed.toLowerCase()}|${limit}|${allowFallback}`;
  if (options.cache !== false) {
    const cached = readCache(cacheKey);
    if (cached) return { ...cached, tookMs: Math.round(performance.now() - started) };
  }

  const providers: WebSearchOutcome["providers"] = [];
  const doFetch = options.fetchImpl;
  /** No single search may spend more than this on fallbacks. */
  const fallbackDeadline = started + 12_000;
  const timeLeft = () => fallbackDeadline - performance.now();

  /* ------------------------------------------------------- mp3juice.sc --- */
  const siteStart = performance.now();
  const site = await searchMp3Juice(trimmed, limit, { fetchImpl: doFetch });
  providers.push({
    provider: "mp3juice",
    ok: site.ok,
    count: site.hits.length,
    error: site.ok ? undefined : site.error,
    tookMs: Math.round(performance.now() - siteStart),
  });

  const siteHits = fromMp3Juice(site.hits);
  let hits = siteHits;
  let fallbackUsed = false;
  const fallbackLabels: string[] = [];

  /* --------------------------------------------------- wider web fallback --- */
  const needsFallback = allowFallback && siteHits.length < Math.min(limit, 3);
  if (needsFallback) {
    fallbackUsed = true;
    const queries = [trimmed];

    if (googleConfigured() && timeLeft() > 0) {
      const t0 = performance.now();
      const google = await searchGoogle(trimmed, limit, { fetchImpl: doFetch });
      providers.push({
        provider: "google",
        ok: google.length > 0,
        count: google.length,
        tookMs: Math.round(performance.now() - t0),
      });
      if (google.length) fallbackLabels.push("Google");
      hits = [...hits, ...google];
    }

    if (hits.length < Math.min(limit, 3) && timeLeft() > 0) {
      const t0 = performance.now();
      const ddg = await searchDuckDuckGo(queries[0], limit, { fetchImpl: doFetch });
      providers.push({
        provider: "duckduckgo",
        ok: ddg.length > 0,
        count: ddg.length,
        error: ddg.length ? undefined : "No parsable web results",
        tookMs: Math.round(performance.now() - t0),
      });
      if (ddg.length) fallbackLabels.push("DuckDuckGo");
      hits = [...hits, ...ddg];
    }

    if (hits.length < Math.min(limit, 3) && timeLeft() > 0) {
      const t0 = performance.now();
      const itunes = await searchItunesMetadata(trimmed, limit, { fetchImpl: doFetch });
      providers.push({
        provider: "itunes",
        ok: itunes.length > 0,
        count: itunes.length,
        error: itunes.length ? undefined : "No catalogue match",
        tookMs: Math.round(performance.now() - t0),
      });
      if (itunes.length) fallbackLabels.push("iTunes");
      hits = [...hits, ...itunes];
    }
  }

  hits = dedupe(hits, limit);

  let notice: string | undefined;
  let live = hits.some((hit) => hit.provider !== "songhub-demo");

  if (!hits.length) {
    hits = offlineWebHits(trimmed, limit);
    live = false;
    notice =
      "mp3juice.sc and the web fallback could not be reached from this machine, so these rows come from the offline demo catalogue.";
  } else if (fallbackUsed && fallbackLabels.length) {
    notice = siteHits.length
      ? `Only ${siteHits.length} mp3juice.sc result${siteHits.length === 1 ? "" : "s"} — topped up with ${fallbackLabels.join(" + ")}.`
      : `Nothing on mp3juice.sc for “${trimmed}”, so SongHub searched ${fallbackLabels.join(" + ")} instead.`;
  } else if (!site.ok && siteHits.length === 0 && allowFallback) {
    notice = `mp3juice.sc did not answer (${site.error ?? "no response"}).`;
  }

  const outcome: WebSearchOutcome = {
    query: trimmed,
    hits,
    providers,
    live,
    fallbackUsed,
    tookMs: Math.round(performance.now() - started),
    notice,
  };

  if (options.cache !== false) writeCache(cacheKey, outcome);
  return outcome;
}

/** Human-readable one-liner used by the API + UI. */
export function describeHit(hit: WebSearchHit): string {
  const base = cleanSearchTitle(`${hit.artist} — ${hit.title}`);
  return hit.durationSec ? `${base} (${Math.floor(hit.durationSec / 60)}:${String(hit.durationSec % 60).padStart(2, "0")})` : base;
}
