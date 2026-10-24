/**
 * Online music search.
 *
 * SongHub talks to keyless, CORS-free public catalogues:
 *   • Internet Archive  — huge, free, permissive licensing metadata
 *   • iTunes Search      — 30-second previews, excellent metadata coverage
 *   • Jamendo            — Creative-Commons catalogue (optional API key)
 *
 * Every provider has a hard 4s timeout and a deterministic offline fallback, so
 * the app is fully functional (and testable) with no network at all — results
 * are then clearly labelled "offline demo catalog".
 */

import type { OnlineResult, BrowseDocument, BrowseBlock } from "../types";
import { TRACKS } from "../catalog/tracks";
import { hashString, clamp } from "../util";

const TIMEOUT_MS = 4000;

export interface ProviderMeta {
  id: string;
  label: string;
  homepage: string;
  license: string;
  requiresKey: boolean;
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "itunes", label: "iTunes Search", homepage: "https://itunes.apple.com", license: "30-second preview (fair use)", requiresKey: false },
  { id: "archive", label: "Internet Archive", homepage: "https://archive.org", license: "Varies — per-item (often CC)", requiresKey: false },
  { id: "jamendo", label: "Jamendo", homepage: "https://www.jamendo.com", license: "Creative Commons", requiresKey: true },
  { id: "local-web", label: "SongHub demo web", homepage: "https://example.org/songhub-demo", license: "Generated preview", requiresKey: false },
];

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "SongHub/1.0 (+personal music assistant)" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

interface ItunesTrack {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  previewUrl?: string;
  trackViewUrl?: string;
}

async function searchItunes(query: string, limit: number): Promise<OnlineResult[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}`;
  const json = (await fetchJson(url)) as { results?: ItunesTrack[] };
  return (json.results ?? [])
    .filter((r) => r.trackName && r.artistName)
    .map((r, i) => ({
      id: `itunes:${r.trackId ?? i}`,
      title: r.trackName!,
      artist: r.artistName!,
      album: r.collectionName,
      durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
      source: "itunes",
      sourceLabel: "iTunes Search",
      sourceUrl: r.trackViewUrl ?? `https://music.apple.com/search?term=${encodeURIComponent(`${r.artistName} ${r.trackName}`)}`,
      license: "30-second preview (fair use)",
      confidence: 0.9,
      downloadable: Boolean(r.previewUrl),
      notes: r.previewUrl ? "Preview available for temporary playback" : "Metadata only",
      audioUrl: r.previewUrl,
    }));
}

interface ArchiveDoc {
  identifier?: string;
  title?: string;
  creator?: string | string[];
  year?: string;
  licenseurl?: string;
}

async function searchArchive(query: string, limit: number): Promise<OnlineResult[]> {
  const q = `(${query}) AND mediatype:(audio)`;
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=licenseurl&rows=${limit}&page=1&output=json`;
  const json = (await fetchJson(url)) as { response?: { docs?: ArchiveDoc[] } };
  return (json.response?.docs ?? [])
    .filter((d) => d.identifier && d.title)
    .map((d, i) => {
      const creator = Array.isArray(d.creator) ? d.creator.join(", ") : d.creator ?? "Unknown";
      return {
        id: `archive:${d.identifier}`,
        title: d.title!,
        artist: creator,
        durationSec: undefined,
        source: "archive",
        sourceLabel: "Internet Archive",
        sourceUrl: `https://archive.org/details/${d.identifier}`,
        license: d.licenseurl ? `Licensed: ${d.licenseurl}` : "Public/Archive item — check item page",
        confidence: 0.7 - i * 0.02,
        downloadable: true,
        notes: d.year ? `From ${d.year}` : undefined,
      };
    });
}

async function searchJamendo(query: string, limit: number): Promise<OnlineResult[]> {
  const key = process.env.JAMENDO_CLIENT_ID;
  if (!key) return [];
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(key)}&format=json&limit=${limit}&search=${encodeURIComponent(query)}&audioformat=mp32`;
  const json = (await fetchJson(url)) as { results?: { id: string; name: string; artist_name: string; album_name?: string; duration?: number; shareurl?: string; audiodownload?: string; license_ccurl?: string }[] };
  return (json.results ?? []).map((r) => ({
    id: `jamendo:${r.id}`,
    title: r.name,
    artist: r.artist_name,
    album: r.album_name,
    durationSec: r.duration,
    source: "jamendo",
    sourceLabel: "Jamendo",
    sourceUrl: r.shareurl ?? `https://www.jamendo.com/track/${r.id}`,
    license: r.license_ccurl ?? "Creative Commons",
    confidence: 0.85,
    downloadable: Boolean(r.audiodownload),
    notes: "Creative Commons licensed",
  }));
}

/* --------------------------------------------------- offline demo web ---- */

/**
 * When the network is unavailable the app still needs to answer "search the web
 * for this". We synthesise a deterministic catalogue of plausible web results
 * that map to catalog tracks, clearly labelled as demo data.
 */
export function offlineResults(query: string, limit = 8): OnlineResult[] {
  const q = query.toLowerCase().trim();
  const scored = TRACKS.map((track) => {
    const haystack = `${track.title} ${track.artist} ${track.album} ${track.genres.join(" ")} ${track.moods.join(" ")} ${track.soundsLike.join(" ")}`.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    let score = 0;
    for (const token of tokens) {
      if (token.length <= 2) continue;
      if (haystack.includes(token)) score += 1;
      // an exact title/artist hit should always outrank incidental metadata
      if (track.title.toLowerCase().includes(token)) score += 6;
      if (track.artist.toLowerCase().includes(token)) score += 2;
    }
    if (track.title.toLowerCase().includes(q)) score += 12;
    if (track.artist.toLowerCase().includes(q)) score += 5;
    const seed = hashString(`${track.id}:${q}`) % 100;
    return { track, score: score + seed / 1000 };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ track }, i) => ({
    id: `local-web:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.duration,
    source: "local-web",
    sourceLabel: "SongHub demo web",
    sourceUrl: `songhub://web/${track.id}`,
    license: "Generated preview — safe to play for 30s",
    confidence: clamp(0.72 - i * 0.03, 0.2, 0.9),
    downloadable: true,
    notes: "Offline demo result (no internet connection to the live catalogs)",
  }));
}

export interface OnlineSearchOutcome {
  query: string;
  results: OnlineResult[];
  providers: { provider: string; ok: boolean; count: number; error?: string; tookMs: number }[];
  live: boolean;
  tookMs: number;
  notice?: string;
}

export async function searchOnline(query: string, limit = 8): Promise<OnlineSearchOutcome> {
  const started = performance.now();
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query,
      results: [],
      providers: [],
      live: false,
      tookMs: 0,
      notice: "Type something to search — a title, an artist, or describe what you heard.",
    };
  }

  const providers = [
    { id: "itunes", run: () => searchItunes(trimmed, limit) },
    { id: "archive", run: () => searchArchive(trimmed, limit) },
    { id: "jamendo", run: () => searchJamendo(trimmed, limit) },
  ];

  const settled = await Promise.all(
    providers.map(async (provider) => {
      const t0 = performance.now();
      try {
        const results = await provider.run();
        return { provider: provider.id, ok: true, count: results.length, tookMs: Math.round(performance.now() - t0), results };
      } catch (error) {
        return {
          provider: provider.id,
          ok: false,
          count: 0,
          tookMs: Math.round(performance.now() - t0),
          error: error instanceof Error ? error.message : String(error),
          results: [] as OnlineResult[],
        };
      }
    }),
  );

  const liveResults = settled.flatMap((s) => s.results);
  const providersReport = settled.map(({ provider, ok, count, tookMs, error }) => ({ provider, ok, count, tookMs, error }));

  if (!liveResults.length) {
    const offline = offlineResults(trimmed, limit);
    return {
      query,
      results: offline,
      providers: providersReport,
      live: false,
      tookMs: Math.round(performance.now() - started),
      notice: providersReport.some((p) => !p.ok)
        ? "Live catalogs were unreachable, so these results come from the offline demo catalogue."
        : `No live results for “${trimmed}” — showing demo catalogue matches.`,
    };
  }

  // de-duplicate by title+artist, keeping the most confident provider
  const seen = new Set<string>();
  const deduped: OnlineResult[] = [];
  for (const result of liveResults.sort((a, b) => b.confidence - a.confidence)) {
    const key = `${result.title.toLowerCase()}|${result.artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }

  return {
    query,
    results: deduped.slice(0, limit),
    providers: providersReport,
    live: true,
    tookMs: Math.round(performance.now() - started),
  };
}

/** Direct lookup of one online result by id (used by the download endpoint). */
export async function lookupOnlineResult(id: string, hintQuery?: string): Promise<OnlineResult | null> {
  const [source, rest] = id.split(/:(.+)/);
  if (!source || !rest) return null;

  if (source === "local-web") {
    return offlineResults(hintQuery ?? rest, 12).find((r) => r.id === id) ?? null;
  }

  const outcome = await searchOnline(hintQuery ?? rest, 12);
  const exact = outcome.results.find((r) => r.id === id);
  if (exact) return exact;
  return outcome.results.find((r) => r.source === source) ?? null;
}

/* ------------------------------------------------------ in-app browser ---- */

const BLOCK_LIMIT = 60;

/** Very small HTML -> blocks extractor (no DOM dependency, works in Node). */
export function htmlToDocument(url: string, html: string, live: boolean): BrowseDocument {
  const title = decodeEntities(/(?:<title[^>]*>)([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "") || url;
  const description =
    decodeEntities(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
        "",
    ) || "No description available.";

  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const blocks: BrowseBlock[] = [];
  const links: BrowseDocument["links"] = [];

  // A small sequential tag scanner: far more robust than one clever regex,
  // and it correctly handles nesting like <p>a <a href>b</a> c</p>.
  const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "p", "li", "a", "blockquote", "figcaption"]);
  const tagRe = /<(\/)?([a-z0-9]+)((?:"[^"]*"|'[^']*'|[^>])*)>/gi;

  let current: { tag: string; attrs: string; text: string } | null = null;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const flush = () => {
    if (!current) return;
    const text = decodeEntities(current.text.replace(/\s+/g, " ").trim());
    const { tag, attrs } = current;
    current = null;
    if (!text) return;
    if (blocks.length >= BLOCK_LIMIT) return;
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
      blocks.push({ type: "heading", text, level: Number(tag[1]) });
    } else if (tag === "a") {
      const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
      const absolute = href ? absolutise(url, href) : undefined;
      blocks.push({ type: "link", text, href: absolute });
      if (absolute) links.push({ text, href: absolute, internal: absolute.startsWith("/") });
    } else {
      blocks.push({ type: "text", text });
    }
  };

  const appendText = (raw: string) => {
    const text = raw.replace(/\s+/g, " ");
    if (!text.trim()) return;
    if (current) current.text += ` ${text}`;
    else if (text.trim().length > 1 && blocks.length < BLOCK_LIMIT) {
      blocks.push({ type: "text", text: decodeEntities(text.trim()) });
    }
  };

  while ((match = tagRe.exec(body)) !== null) {
    // text between the previous tag and this one
    if (match.index > cursor) appendText(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const closing = Boolean(match[1]);
    const name = (match[2] ?? "").toLowerCase();
    const attrs = match[3] ?? "";

    if (name === "img") {
      const src = /src=["']([^"']+)["']/i.exec(attrs)?.[1];
      if (src && blocks.length < BLOCK_LIMIT) blocks.push({ type: "image", src: absolutise(url, src) });
      continue;
    }
    if (name === "audio" || name === "source") {
      const src = /src=["']([^"']+)["']/i.exec(attrs)?.[1];
      if (src && blocks.length < BLOCK_LIMIT) blocks.push({ type: "audio", src: absolutise(url, src) });
      continue;
    }
    if (name === "br") {
      if (current) current.text += " ";
      continue;
    }
    if (!BLOCK_TAGS.has(name)) continue;

    if (closing) {
      if (current && current.tag === name) flush();
      continue;
    }
    flush();
    current = { tag: name, attrs, text: "" };
  }
  if (cursor < body.length) appendText(body.slice(cursor));
  flush();

  return {
    url,
    title: decodeEntities(title),
    description,
    blocks,
    fetchedLive: live,
    source: live ? new URL(url, "https://example.org").host : "SongHub demo web",
    fetchedAt: new Date().toISOString(),
    links: links.slice(0, 40),
  };
}

function absolutise(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Offline document for one result, used when the page cannot be fetched. */
export function offlineDocument(result: OnlineResult): BrowseDocument {
  const track = TRACKS.find((t) => result.title === t.title && result.artist === t.artist);
  const blocks: BrowseBlock[] = [
    { type: "heading", text: result.title, level: 1 },
    { type: "meta", text: `${result.artist}${result.album ? ` — ${result.album}` : ""}` },
    { type: "text", text: result.notes ?? "Result captured from the SongHub demo catalogue." },
    { type: "meta", text: `Source: ${result.sourceLabel} · License: ${result.license}` },
  ];
  if (track) {
    blocks.push({ type: "heading", text: "About this recording", level: 2 });
    blocks.push({ type: "text", text: track.description });
    blocks.push({
      type: "text",
      text: `Sounds like ${track.soundsLike.join(", ")}. ${track.bpm} BPM, ${track.musicalKey}, ${track.year}, ${track.instrumental ? "instrumental" : "with vocals"}.`,
    });
    blocks.push({ type: "audio", src: `/api/stream/${track.id}` });
    blocks.push({ type: "link", text: `Open “${track.title}” in SongHub`, href: `/track/${track.id}` });
  }
  return {
    url: result.sourceUrl,
    title: result.title,
    description: result.notes ?? `${result.title} by ${result.artist}`,
    blocks,
    fetchedLive: false,
    source: "SongHub demo web",
    fetchedAt: new Date().toISOString(),
    links: track ? [{ text: `Open “${track.title}” in SongHub`, href: `/track/${track.id}`, internal: true }] : [],
    notice: "This page was rendered from the offline demo catalogue because live browsing is unavailable.",
  };
}

/** Fetch a real page (best effort) with an 5s cap, falling back to the demo doc. */
export async function browseUrl(url: string, fallback?: OnlineResult): Promise<BrowseDocument> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "SongHub/1.0 (+in-app browser)", accept: "text/html,*/*" },
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) throw new Error(`Unsupported content type ${contentType}`);
    const html = await res.text();
    return htmlToDocument(url, html.slice(0, 400_000), true);
  } catch (error) {
    if (fallback) return offlineDocument(fallback);
    return {
      url,
      title: url,
      description: "Could not load this page.",
      blocks: [{ type: "text", text: error instanceof Error ? error.message : "Unknown error" }],
      fetchedLive: false,
      source: "offline",
      fetchedAt: new Date().toISOString(),
      links: [],
      notice: "Live browsing is unavailable in this environment.",
    };
  }
}
