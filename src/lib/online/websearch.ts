/**
 * Wider-web fallback used when mp3juice.sc has nothing for a query.
 *
 * Order: Google Programmable Search (when `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`
 * are configured) → DuckDuckGo HTML (keyless) → iTunes/Internet Archive
 * metadata. Each hit keeps the page URL of the result it came from, so a
 * playlist entry can always point back at its source.
 */

import type { WebSearchHit } from "../types";
import { cleanText, decodeEntities, splitArtistTitle, stripTags } from "./html";
import type { FetchLike } from "./mp3juice";

const TIMEOUT_MS = 5000;

const HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function hashId(prefix: string, value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}:${hash.toString(36)}`;
}

/** Strip the noise search engines append to result titles. */
export function cleanSearchTitle(raw: string): string {
  let text = cleanText(stripTags(raw));
  const suffixes = [
    /\s*[|\-–—]\s*YouTube( Music)?\s*$/i,
    /\s*[|\-–—]\s*Spotify\s*$/i,
    /\s*[|\-–—]\s*SoundCloud\s*$/i,
    /\s*[|\-–—]\s*Apple Music\s*$/i,
    /\s*[|\-–—]\s*Deezer\s*$/i,
    /\s*[|\-–—]\s*Last\.?fm\s*$/i,
    /\s*[|\-–—]\s*Shazam\s*$/i,
    /\s*[|\-–—]\s*(?:free )?mp3( download)?\s*$/i,
  ];
  for (const suffix of suffixes) text = text.replace(suffix, "");
  return text
    .replace(/\s*\((?:official\s+)?(?:music\s+)?video\)/gi, "")
    .replace(/\s*\[(?:official\s+)?(?:music\s+)?video\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isArtistFirstHost(url: string): boolean {
  return /(?:^|\.)(?:youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|audiomack\.com)$/i.test(safeHost(url));
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** "Daft Punk - Topic" -> "Daft Punk"; "DaftPunkVEVO" -> "DaftPunk". */
function cleanArtistName(value: string): string {
  return cleanText(value)
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*Official$/i, "")
    .trim();
}

/** Turn a search-result title into {title, artist} using the host convention. */
export function parseSearchResultTitle(raw: string, url: string): { title: string; artist: string } {
  const cleaned = cleanSearchTitle(raw);
  const split = splitArtistTitle(cleaned, isArtistFirstHost(url) ? "artist-first" : "auto");
  return {
    title: split.title || cleaned,
    artist: cleanArtistName(split.artist ?? "") || "Unknown artist",
  };
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID);
}

interface GoogleItem {
  title?: string;
  link?: string;
  snippet?: string;
}

/** Parse a Google Programmable Search JSON response. */
export function parseGoogleResults(json: unknown, limit = 10): WebSearchHit[] {
  const items = (json as { items?: GoogleItem[] } | null)?.items ?? [];
  const hits: WebSearchHit[] = [];
  for (const item of items) {
    if (!item.link || !item.title) continue;
    const { title, artist } = parseSearchResultTitle(item.title, item.link);
    if (!title) continue;
    hits.push({
      id: hashId("google", item.link),
      title,
      artist,
      sourceUrl: item.link,
      provider: "google",
      providerLabel: "Google",
      confidence: 0.8,
      notes: item.snippet ? cleanText(item.snippet).slice(0, 180) : undefined,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Google Programmable Search (needs GOOGLE_API_KEY + GOOGLE_CSE_ID). */
export async function searchGoogle(
  query: string,
  limit = 10,
  options: { fetchImpl?: FetchLike; apiKey?: string; cx?: string } = {},
): Promise<WebSearchHit[]> {
  const key = options.apiKey ?? process.env.GOOGLE_API_KEY;
  const cx = options.cx ?? process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];
  const doFetch = options.fetchImpl ?? fetch;
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}` +
    `&num=${Math.min(10, Math.max(1, limit))}&q=${encodeURIComponent(`${query} song`)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: HEADERS, cache: "no-store" });
    if (!res.ok) return [];
    return parseGoogleResults(await res.json(), limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the keyless DuckDuckGo HTML endpoint. */
export function parseDuckDuckGo(html: string, limit = 10): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const linkRe = /<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && hits.length < limit) {
    const attrs = match[1] ?? "";
    const hrefRaw = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!hrefRaw) continue;
    const url = unwrapDuckDuckGoLink(decodeEntities(hrefRaw));
    if (!/^https?:\/\//i.test(url)) continue;
    const { title, artist } = parseSearchResultTitle(match[2] ?? "", url);
    if (!title) continue;
    hits.push({
      id: hashId("duckduckgo", url),
      title,
      artist,
      sourceUrl: url,
      provider: "duckduckgo",
      providerLabel: "DuckDuckGo",
      confidence: 0.72,
      notes: "Found by the keyless web search fallback.",
    });
  }
  return hits;
}

/** DuckDuckGo wraps outbound links as //duckduckgo.com/l/?uddg=<encoded>. */
function unwrapDuckDuckGoLink(href: string): string {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(absolute, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return absolute;
  }
}

/** Keyless web search via DuckDuckGo's no-JS endpoint. */
export async function searchDuckDuckGo(
  query: string,
  limit = 10,
  options: { fetchImpl?: FetchLike } = {},
): Promise<WebSearchHit[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} song`)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: HEADERS, cache: "no-store" });
    if (!res.ok) return [];
    return parseDuckDuckGo(await res.text(), limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

interface ItunesRow {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  previewUrl?: string;
  trackViewUrl?: string;
  trackTimeMillis?: number;
}

/** Last-resort metadata from the iTunes catalogue (also yields a preview). */
export async function searchItunesMetadata(
  query: string,
  limit = 8,
  options: { fetchImpl?: FetchLike } = {},
): Promise<WebSearchHit[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: HEADERS, cache: "no-store" });
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: ItunesRow[] };
    return (json.results ?? [])
      .filter((row) => row.trackName && row.artistName)
      .map((row) => {
        const sourceUrl = row.trackViewUrl ?? `https://music.apple.com/search?term=${encodeURIComponent(query)}`;
        return {
          id: hashId("itunes", sourceUrl),
          title: row.trackName!,
          artist: row.artistName!,
          album: row.collectionName,
          durationSec: row.trackTimeMillis ? Math.round(row.trackTimeMillis / 1000) : undefined,
          sourceUrl,
          provider: "itunes",
          providerLabel: "iTunes Search",
          confidence: 0.75,
          audioUrl: row.previewUrl,
          playbackKind: row.previewUrl ? ("preview" as const) : undefined,
          notes: row.previewUrl ? "Official 30-second preview available" : "Metadata only",
        } satisfies WebSearchHit;
      });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
