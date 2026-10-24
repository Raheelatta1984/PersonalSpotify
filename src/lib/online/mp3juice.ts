/**
 * mp3juice.sc search scraper.
 *
 * The site is a search engine over public music metadata: you type a song, it
 * returns rows of "Artist - Title" with a link to that song's page. SongHub
 * scrapes **metadata only** (title, artist, duration, artwork, canonical song
 * URL) so the real song can be found, labelled and saved to a playlist.
 *
 * Playback is handled separately by `resolvePlayback()`, which only ever uses
 * audio the rights-holder publishes (Apple's licensed previews, Internet
 * Archive, Jamendo) and otherwise synthesises a short preview. No stream
 * ripping, no YouTube extraction, no DRM bypass — see `webMusic/README` notes
 * in the project README.
 *
 * The parser is deliberately multi-strategy and side-effect free so it can be
 * unit-tested against saved fixtures without touching the network.
 */

import { attr, absolutise, cleanText, decodeEntities, normalizeForMatch, parseClock, splitArtistTitle, stripTags } from "./html";

export const DEFAULT_MP3JUICE_BASE = "https://mp3juice.sc";

export function mp3juiceBase(): string {
  return (process.env.MP3JUICE_BASE_URL ?? DEFAULT_MP3JUICE_BASE).replace(/\/+$/, "");
}

export interface Mp3JuiceHit {
  /** Stable id derived from the song page URL. */
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  artworkUrl?: string;
  /** The song page URL on mp3juice.sc — this is what a playlist entry keeps. */
  pageUrl: string;
  notes?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 5000;
/** Never keep a search waiting for more than this across all endpoints. */
const TOTAL_BUDGET_MS = 9000;

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};

/** Ranked list of search endpoints — clones of the site differ, so try them all. */
export function buildSearchEndpoints(query: string, base = mp3juiceBase()): string[] {
  const q = encodeURIComponent(query.trim());
  return [
    `${base}/search?q=${q}`,
    `${base}/?s=${q}`,
    `${base}/search/${q}`,
    `${base}/results?q=${q}`,
    `${base}/api/search?q=${q}&limit=20`,
    `${base}/search?query=${q}`,
  ];
}

/** Slug-safe deterministic id for a hit (kept short so URLs stay tidy). */
export function mp3juiceHitId(pageUrl: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pageUrl.length; i++) {
    hash ^= pageUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mp3juice:${hash.toString(36)}`;
}

interface ParsedCandidate {
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  artworkUrl?: string;
  pageUrl?: string;
}

/** Strategy 1: elements carrying the site's own data-* attributes. */
function parseDataAttributes(html: string, base: string): ParsedCandidate[] {
  const out: ParsedCandidate[] = [];
  const tagRe = /<([a-z0-9]+)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const attrs = match[2] ?? "";
    const songTitle = attr(attrs, "data-songtitle") ?? attr(attrs, "data-title") ?? attr(attrs, "data-song");
    const artist = attr(attrs, "data-artist") ?? attr(attrs, "data-artistname") ?? attr(attrs, "data-author");
    if (!songTitle && !artist) continue;

    const id = attr(attrs, "data-id") ?? attr(attrs, "data-songid") ?? attr(attrs, "data-key");
    const href = attr(attrs, "href") ?? attr(attrs, "data-url") ?? attr(attrs, "data-href");
    let pageUrl: string | undefined;
    if (href && !/^(#|javascript:)/i.test(href)) {
      pageUrl = absolutise(base, href);
    } else if (id) {
      pageUrl = `${base}/download?id=${encodeURIComponent(id)}`;
    }
    if (!pageUrl && id) pageUrl = `${base}/download?id=${encodeURIComponent(id)}`;

    const duration =
      attr(attrs, "data-duration") ?? attr(attrs, "data-time") ?? attr(attrs, "data-length") ?? attr(attrs, "data-durationsec");
    const artwork =
      attr(attrs, "data-thumbnail") ?? attr(attrs, "data-image") ?? attr(attrs, "data-artwork") ?? attr(attrs, "data-cover");
    const album = attr(attrs, "data-album") ?? attr(attrs, "data-collection");

    const split = songTitle
      ? { title: cleanText(songTitle), artist: cleanText(artist ?? "") || undefined }
      : splitArtistTitle(artist ?? "");
    if (!split.title) continue;
    out.push({
      title: split.title,
      artist: split.artist,
      album: cleanText(album ?? "") || undefined,
      durationSec: parseClock(duration),
      artworkUrl: absolutise(base, artwork),
      pageUrl,
    });
  }
  return out;
}

/** Strategy 2: embedded JSON blobs (Next.js, Nuxt, hand-rolled window state). */
function parseEmbeddedJson(html: string, base: string): ParsedCandidate[] {
  const blobs: string[] = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (!body || body.length > 500_000) continue;
    const type = attr(attrs, "type") ?? "";
    if (/json/i.test(type)) {
      blobs.push(body);
      continue;
    }
    // window.__INITIAL_STATE__ = {...} / var songs = [...]
    const assigned = /=\s*([{[][\s\S]*[}\]])\s*;?\s*$/m.exec(body);
    if (assigned && /song|track|result|data|search/i.test(body.slice(0, 400))) blobs.push(assigned[1]);
  }

  const out: ParsedCandidate[] = [];
  for (const blob of blobs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      continue;
    }
    walkJson(parsed, (value) => {
      const record = value as Record<string, unknown>;
      const str = (key: string): string | undefined => {
        const v = record[key];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
        return undefined;
      };
      const title = str("title") ?? str("songtitle") ?? str("song") ?? str("name");
      const artist = str("artist") ?? str("artist_name") ?? str("author") ?? str("creator") ?? str("singer");
      const pageRaw = str("url") ?? str("link") ?? str("href") ?? str("permalink") ?? str("page");
      if (!title || !artist) return;
      if (normalizeForMatch(title) === normalizeForMatch(artist)) return;
      const durationRaw = str("duration") ?? str("durationSec") ?? str("length") ?? str("time");
      const artwork = str("thumbnail") ?? str("thumbnailUrl") ?? str("image") ?? str("cover") ?? str("artwork");
      const id = str("id") ?? str("songid") ?? str("videoId") ?? str("key");
      const pageUrl = pageRaw ? absolutise(base, pageRaw) : id ? `${base}/download?id=${encodeURIComponent(id)}` : undefined;
      out.push({
        title: cleanText(title),
        artist: cleanText(artist),
        album: str("album"),
        durationSec: parseClock(durationRaw),
        artworkUrl: artwork ? absolutise(base, artwork) : undefined,
        pageUrl,
      });
    });
  }
  return out;
}

function walkJson(node: unknown, visit: (value: unknown) => void, depth = 0): void {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node as Record<string, unknown>)) walkJson(value, visit, depth + 1);
}

/** Strategy 3: table/list markup with a download link and a clock cell. */
function parseRows(html: string, base: string): ParsedCandidate[] {
  const out: ParsedCandidate[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const inner = row[1] ?? "";
    const cells = [...inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1] ?? ""));
    if (!cells.length) continue;
    const link = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(inner);
    if (!link) continue;
    const href = attr(link[1] ?? "", "href");
    if (!href || !/download|mp3|song|track/i.test(href)) continue;
    const label = cleanText(cells.find((cell) => cell.length > 1 && !/^\d+$/.test(cell) && !/^\d+:\d+/.test(cell)) ?? stripTags(link[2] ?? ""));
    if (!label) continue;
    const split = splitArtistTitle(label);
    out.push({
      title: split.title,
      artist: "artist" in split ? split.artist : undefined,
      durationSec: parseClock(cells.find((cell) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(cell))),
      pageUrl: absolutise(base, href),
    });
  }
  return out;
}

/** Strategy 4: any anchor that points at a song/download page. */
function parseAnchors(html: string, base: string): ParsedCandidate[] {
  const out: ParsedCandidate[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchor: RegExpExecArray | null;
  while ((anchor = anchorRe.exec(html)) !== null) {
    const attrs = anchor[1] ?? "";
    // Rows already handled by the data-* strategy win; their anchor text is
    // often a label ("duplicate", "download") rather than the song name.
    if (attr(attrs, "data-songtitle") || attr(attrs, "data-title")) continue;
    const href = attr(attrs, "href");
    if (!href || !/(download|\/mp3\/|\/song\/|\.mp3($|\?))/i.test(href)) continue;
    const titleAttr = attr(attrs, "title");
    const label = cleanText(titleAttr ?? stripTags(anchor[2] ?? ""));
    if (!label || label.length < 3) continue;
    if (/^(download|play|mp3|search|home|login|sign up)$/i.test(label)) continue;
    const split = splitArtistTitle(label);
    out.push({
      title: split.title,
      artist: "artist" in split ? split.artist : undefined,
      pageUrl: absolutise(base, href),
    });
  }
  return out;
}

/**
 * Parse any mp3juice-style search response (HTML or JSON) into hits.
 * Every strategy runs; results are merged, de-duplicated and ranked.
 */
export function parseMp3JuiceResults(payload: string, baseUrl = mp3juiceBase()): Mp3JuiceHit[] {
  const trimmed = payload.trim();
  const candidates: ParsedCandidate[] = [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(...parseEmbeddedJson(`<script type="application/json">${trimmed}</script>`, baseUrl));
  } else {
    candidates.push(
      ...parseDataAttributes(payload, baseUrl),
      ...parseEmbeddedJson(payload, baseUrl),
      ...parseRows(payload, baseUrl),
      ...parseAnchors(payload, baseUrl),
    );
  }

  const seen = new Set<string>();
  /** title -> artist, used to drop the same song scraped twice by two strategies. */
  const seenTitles = new Map<string, string>();
  const hits: Mp3JuiceHit[] = [];
  for (const candidate of candidates) {
    const title = cleanText(candidate.title);
    if (!title || title.length < 2 || title.length > 300) continue;
    if (/^(unknown|untitled|n\/a)$/i.test(title)) continue;
    const artist = cleanText(candidate.artist) || "Unknown artist";
    // Reject nav/marketing anchors that slipped through.
    if (/mp3juice|download mp3|free mp3|search results/i.test(title)) continue;

    const key = `${normalizeForMatch(title)}|${normalizeForMatch(artist)}`;
    if (seen.has(key)) continue;
    // The data-* strategy runs first, so if the same title already arrived with
    // (or without) an artist, keep the richer row and skip the weaker duplicate.
    const titleKey = normalizeForMatch(title);
    const knownArtist = seenTitles.get(titleKey);
    if (knownArtist !== undefined && (knownArtist === "unknown artist" || artist === "Unknown artist")) continue;
    seen.add(key);
    seenTitles.set(titleKey, artist.toLowerCase());

    const pageUrl = candidate.pageUrl ?? `${baseUrl}/search?q=${encodeURIComponent(`${artist} ${title}`)}`;
    hits.push({
      id: mp3juiceHitId(pageUrl),
      title,
      artist,
      album: candidate.album ? cleanText(candidate.album) : undefined,
      durationSec: candidate.durationSec,
      artworkUrl: candidate.artworkUrl,
      pageUrl,
      notes: undefined,
    });
  }

  return rankHits(hits);
}

/** Prefer rows that actually carry a song page and a duration. */
function rankHits(hits: Mp3JuiceHit[]): Mp3JuiceHit[] {
  return hits
    .map((hit, index) => {
      let score = 100 - index;
      if (/\/(download|song|mp3)/i.test(hit.pageUrl)) score += 6;
      if (hit.durationSec && hit.durationSec > 20) score += 4;
      if (hit.artworkUrl) score += 2;
      if (hit.artist !== "Unknown artist") score += 5;
      return { hit, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.hit);
}

export interface Mp3JuiceSearchResult {
  hits: Mp3JuiceHit[];
  endpoint: string | null;
  ok: boolean;
  error?: string;
  attempts: { endpoint: string; status: number | null; count: number; error?: string }[];
}

/**
 * Search mp3juice.sc. Tries each endpoint until one returns parsable rows.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function searchMp3Juice(
  query: string,
  limit = 12,
  options: { fetchImpl?: FetchLike; base?: string } = {},
): Promise<Mp3JuiceSearchResult> {
  const q = query.trim();
  const attempts: Mp3JuiceSearchResult["attempts"] = [];
  if (!q) return { hits: [], endpoint: null, ok: false, error: "Empty query", attempts };

  const doFetch = options.fetchImpl ?? fetch;
  const base = options.base ?? mp3juiceBase();
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const endpoint of buildSearchEndpoints(q, base)) {
    if (Date.now() > deadline) {
      attempts.push({ endpoint, status: null, count: 0, error: "Search budget exhausted" });
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(endpoint, {
        signal: controller.signal,
        headers: { ...BROWSER_HEADERS, referer: `${base}/` },
        cache: "no-store",
      });
      if (!res.ok) {
        attempts.push({ endpoint, status: res.status, count: 0 });
        continue;
      }
      const body = (await res.text()).slice(0, 1_500_000);
      const hits = parseMp3JuiceResults(body, base).slice(0, limit);
      attempts.push({ endpoint, status: res.status, count: hits.length });
      if (hits.length) return { hits, endpoint, ok: true, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ endpoint, status: null, count: 0, error: message });
      // DNS/connection failures mean the host is unreachable — trying five more
      // paths on the same host just burns the budget.
      if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|aborted|timeout/i.test(message)) break;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    hits: [],
    endpoint: null,
    ok: false,
    error: attempts.find((a) => a.error)?.error ?? "No parsable results",
    attempts,
  };
}

/** Pull `<title>`/OpenGraph metadata out of an mp3juice song page. */
export function parseSongPageMetadata(html: string): { title?: string; artist?: string; description?: string } {
  const og = (property: string): string | undefined => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, "i");
    return re.exec(html)?.[1] ? decodeEntities(re.exec(html)![1]) : undefined;
  };
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const raw = heading ? stripTags(heading) : og("og:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  // Song pages overwhelmingly title themselves "Artist - Song".
  const split = splitArtistTitle(raw, "artist-first");
  return {
    title: split.title || undefined,
    artist: "artist" in split ? split.artist : og("og:site_name"),
    description: og("og:description") ?? og("description"),
  };
}
