/**
 * Resolve a web result to something SongHub is allowed to play.
 *
 * The chain is deliberately conservative and always explicit about what the
 * user is about to hear:
 *
 *   1. audio the provider itself published       -> full / preview
 *   2. Apple iTunes Search licensed preview      -> 30 s preview
 *   3. Internet Archive item that declares a licence, or public domain
 *                                                -> full
 *   4. Jamendo (Creative Commons, needs a key)   -> full
 *   5. nothing lawful found                      -> SongHub synthesises a preview
 *                                                   and says so
 *
 * Anything that would require stream-ripping (pulling a YouTube/SoundCloud
 * stream and converting it) is intentionally out of scope: this resolver only
 * ever hands the player URLs that the rights-holder published.
 */

import type { PlaybackKind } from "../types";
import { diceSimilarity, normalizeForMatch, titleArtistScore } from "./html";
import type { FetchLike } from "./mp3juice";

/**
 * Only https URLs on public hosts are ever fetched. This keeps a crafted search
 * result from turning the player into an SSRF probe against the local network.
 */
export function isSafeAudioUrl(value: string | undefined): value is string {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "::1" || host === "[::1]" || host.startsWith("[")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

export interface PlaybackTarget {
  title: string;
  artist?: string;
  audioUrl?: string;
  provider?: string;
}

export interface PlaybackResolution {
  audioUrl?: string;
  playbackKind: PlaybackKind;
  /** Licence / usage note shown in the UI. */
  license: string;
  /** Which service the audio (not the metadata) came from. */
  audioProvider: string;
  audioProviderLabel: string;
  notes?: string;
}

const NOTHING_FOUND: PlaybackResolution = {
  audioUrl: undefined,
  playbackKind: "generated",
  license: "No licensed recording found — SongHub synthesises a 30 s preview",
  audioProvider: "songhub",
  audioProviderLabel: "SongHub synth preview",
  notes: "The song exists, but no openly playable recording matched. You can still open the source page.",
};

const TIMEOUT_MS = 5000;

async function fetchJsonWithTimeout(url: string, doFetch: FetchLike, timeoutMs = TIMEOUT_MS): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "SongHub/1.0 (+personal music assistant)", accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The provider already gave us playable audio — trust its own labelling. */
function fromProvider(target: PlaybackTarget): PlaybackResolution | null {
  if (!target.audioUrl || !isSafeAudioUrl(target.audioUrl)) return null;
  const provider = target.provider ?? "provider";
  if (provider === "itunes") {
    return {
      audioUrl: target.audioUrl,
      playbackKind: "preview",
      license: "Apple/iTunes licensed 30-second preview",
      audioProvider: "itunes",
      audioProviderLabel: "iTunes preview",
      notes: "Official 30-second preview supplied by the store.",
    };
  }
  return {
    audioUrl: target.audioUrl,
    playbackKind: "full",
    license: provider === "jamendo" ? "Creative Commons" : "Openly published audio",
    audioProvider: provider,
    audioProviderLabel: provider === "jamendo" ? "Jamendo" : "Source audio",
  };
}

interface ItunesTrack {
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
}

/** Licensed 30-second preview from the Apple iTunes Search API (keyless). */
export async function resolveItunesPreview(
  title: string,
  artist: string | undefined,
  doFetch: FetchLike = fetch,
): Promise<PlaybackResolution | null> {
  const term = `${title} ${artist ?? ""}`.replace(/\s+/g, " ").trim();
  if (!term) return null;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=8`;
  const json = (await fetchJsonWithTimeout(url, doFetch)) as { results?: ItunesTrack[] } | null;
  const results = (json?.results ?? []).filter((r) => r.previewUrl && r.trackName);
  if (!results.length) return null;

  const ranked = results
    .map((track) => ({
      track,
      score: titleArtistScore({ title: track.trackName ?? "", artist: track.artistName }, { title, artist }),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  // Require a real title match; otherwise we would play the wrong song.
  if (!best || diceSimilarity(best.track.trackName ?? "", title) < 0.52) return null;

  return {
    audioUrl: best.track.previewUrl,
    playbackKind: "preview",
    license: "Apple/iTunes licensed 30-second preview",
    audioProvider: "itunes",
    audioProviderLabel: "iTunes preview",
    notes: `Closest store match: “${best.track.trackName}” by ${best.track.artistName ?? "unknown"}.`,
  };
}

interface ArchiveSearchDoc {
  identifier?: string;
  title?: string;
  creator?: string | string[];
  licenseurl?: string;
}

interface ArchiveMetadata {
  files?: { name?: string; format?: string; size?: string; length?: string }[];
  metadata?: { licenseurl?: string; title?: string; creator?: string | string[] };
}

/**
 * Internet Archive: only items that declare a licence or live in the public
 * domain are considered, then the first MP3/OGG file is used.
 */
export async function resolveArchiveAudio(
  title: string,
  artist: string | undefined,
  doFetch: FetchLike = fetch,
): Promise<PlaybackResolution | null> {
  const query = `(${title}) ${artist ? `AND (${artist})` : ""} AND mediatype:(audio) AND licenseurl:(*)`;
  const searchUrl =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}` +
    `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=5&page=1&output=json`;
  const json = (await fetchJsonWithTimeout(searchUrl, doFetch)) as { response?: { docs?: ArchiveSearchDoc[] } } | null;
  const docs = (json?.response?.docs ?? []).filter((doc) => doc.identifier && doc.licenseurl);
  if (!docs.length) return null;

  for (const doc of docs) {
    const meta = (await fetchJsonWithTimeout(
      `https://archive.org/metadata/${encodeURIComponent(doc.identifier!)}`,
      doFetch,
    )) as ArchiveMetadata | null;
    const license = meta?.metadata?.licenseurl ?? doc.licenseurl;
    if (!license) continue;
    const file = (meta?.files ?? []).find(
      (entry) => entry.name && (/\.mp3$/i.test(entry.name) || /mp3/i.test(entry.format ?? "")),
    );
    if (!file?.name) continue;
    return {
      audioUrl: `https://archive.org/download/${encodeURIComponent(doc.identifier!)}/${file.name
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`,
      playbackKind: "full",
      license: `Internet Archive · ${license}`,
      audioProvider: "archive",
      audioProviderLabel: "Internet Archive",
      notes: `Playing the archive item “${doc.title ?? doc.identifier}”.`,
    };
  }
  return null;
}

interface JamendoTrack {
  name?: string;
  artist_name?: string;
  audio?: string;
  audiodownload?: string;
  license_ccurl?: string;
}

/** Jamendo Creative-Commons catalogue (needs JAMENDO_CLIENT_ID). */
export async function resolveJamendoAudio(
  title: string,
  artist: string | undefined,
  key: string | undefined,
  doFetch: FetchLike = fetch,
): Promise<PlaybackResolution | null> {
  if (!key) return null;
  const url =
    `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(key)}&format=json&limit=5` +
    `&search=${encodeURIComponent(`${title} ${artist ?? ""}`.trim())}&audioformat=mp32`;
  const json = (await fetchJsonWithTimeout(url, doFetch)) as { results?: JamendoTrack[] } | null;
  const results = (json?.results ?? []).filter((track) => track.audio || track.audiodownload);
  if (!results.length) return null;
  const best = results
    .map((track) => ({ track, score: titleArtistScore({ title: track.name ?? "", artist: track.artist_name }, { title, artist }) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.45) return null;
  return {
    audioUrl: best.track.audiodownload ?? best.track.audio,
    playbackKind: "full",
    license: best.track.license_ccurl ? `Creative Commons · ${best.track.license_ccurl}` : "Creative Commons",
    audioProvider: "jamendo",
    audioProviderLabel: "Jamendo",
    notes: `Creative-Commons recording “${best.track.name}” by ${best.track.artist_name}.`,
  };
}

export interface ResolveOptions {
  fetchImpl?: FetchLike;
  /** Disable individual steps (tests / offline mode). */
  allow?: { itunes?: boolean; archive?: boolean; jamendo?: boolean };
  jamendoKey?: string;
}

/**
 * Run the lawful resolution chain. Never throws: the worst case is a
 * `generated` preview so playback inside the app always works.
 */
export async function resolvePlayback(
  target: PlaybackTarget,
  options: ResolveOptions = {},
): Promise<PlaybackResolution> {
  const doFetch = options.fetchImpl ?? fetch;
  const allow = { itunes: true, archive: true, jamendo: true, ...options.allow };

  const direct = fromProvider(target);
  if (direct) return direct;

  const title = target.title.trim();
  if (!title) return NOTHING_FOUND;

  if (allow.itunes) {
    const preview = await resolveItunesPreview(title, target.artist, doFetch);
    if (preview) return preview;
  }
  if (allow.jamendo) {
    const jamendo = await resolveJamendoAudio(title, target.artist, options.jamendoKey ?? process.env.JAMENDO_CLIENT_ID, doFetch);
    if (jamendo) return jamendo;
  }
  if (allow.archive) {
    const archive = await resolveArchiveAudio(title, target.artist, doFetch);
    if (archive) return archive;
  }

  return { ...NOTHING_FOUND, notes: `No licensed recording found for “${title}”.` };
}

/** True when the target is specific enough that a match is meaningful. */
export function isResolvableTarget(text: string): boolean {
  return normalizeForMatch(text).length >= 2;
}
