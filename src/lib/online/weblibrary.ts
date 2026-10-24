/**
 * The saved-web-song registry.
 *
 * When a search result is played or added to a playlist it is persisted here
 * (`.data/web-tracks.json`) with its **real title**, artist and the **actual
 * song URL** it came from. Playlists then store the `web_…` id and every layer
 * resolves it back to a full `Track` via `webTrackToTrack()`, so a web song
 * behaves exactly like a catalog track: it renders, queues, plays and survives
 * a restart.
 */

import type { PlaybackKind, Track, TrackSpec, WebSearchHit, WebTrack } from "../types";
import { getTrack } from "../catalog/tracks";
import { readJson, writeJson } from "../storage";
import { hashString } from "../util";
import { normalizeForMatch } from "./html";
import { isSafeAudioUrl, resolvePlayback, type PlaybackResolution, type ResolveOptions } from "./resolve";

const WEB_TRACKS_FILE = "web-tracks.json";
const MAX_WEB_TRACKS = 500;

interface WebTrackStore {
  tracks: WebTrack[];
  updatedAt: string;
}

const EMPTY: WebTrackStore = { tracks: [], updatedAt: new Date(0).toISOString() };

async function readStore(): Promise<WebTrackStore> {
  const store = await readJson<WebTrackStore>(WEB_TRACKS_FILE, { ...EMPTY, tracks: [] });
  return { tracks: Array.isArray(store.tracks) ? store.tracks : [], updatedAt: store.updatedAt ?? EMPTY.updatedAt };
}

async function writeStore(store: WebTrackStore): Promise<void> {
  await writeJson(WEB_TRACKS_FILE, { ...store, updatedAt: new Date().toISOString() });
}

/* --------------------------------------------------------------- helpers ---- */

export function isWebTrackId(id: string): boolean {
  return typeof id === "string" && id.startsWith("web_");
}

/** Stable id: the same song URL always produces the same id. */
export function webTrackId(title: string, artist: string, sourceUrl: string): string {
  const seed = `${normalizeForMatch(title)}|${normalizeForMatch(artist)}|${normalizeForMatch(sourceUrl.replace(/^https?:\/\//, ""))}`;
  return `web_${hashString(seed).toString(36)}`;
}

export function webPalette(seed: string): [string, string] {
  const hue = hashString(seed) % 360;
  const hue2 = (hue + 36) % 360;
  return [`hsl(${hue} 78% 58%)`, `hsl(${hue2} 62% 26%)`];
}

/** A deterministic synth spec so even an unresolved song has real audio. */
export function specForWebTrack(web: Pick<WebTrack, "id" | "durationSec">): TrackSpec {
  const h = hashString(web.id);
  const bpm = 84 + (h % 42);
  const roots = [36, 38, 40, 41, 43, 45];
  const scales: number[][] = [
    [0, 2, 3, 5, 7, 8, 10],
    [0, 2, 4, 5, 7, 9, 11],
    [0, 3, 5, 7, 10],
    [0, 2, 3, 5, 7, 9, 10],
  ];
  const seconds = Math.max(web.durationSec ?? 30, 30);
  return {
    root: roots[h % roots.length],
    scale: scales[(h >>> 3) % scales.length],
    progression: [0, 5, 3, 4].map((degree) => (degree + (h % 3)) % 7),
    bpm,
    bars: Math.min(64, Math.max(8, Math.ceil((seconds * bpm) / 240))),
    voices: {
      pad: true,
      bass: true,
      arp: (h & 1) === 0,
      drums: (h & 2) === 0,
      pluck: (h & 4) === 0,
      shimmer: (h & 8) === 0,
    },
    swing: ((h >>> 5) % 30) / 100,
    gain: 1.05,
    seed: h,
  };
}

/** Adapt a saved web song to the same `Track` shape the whole UI speaks. */
export function webTrackToTrack(web: WebTrack): Track {
  const spec = specForWebTrack(web);
  const added = new Date(web.addedAt);
  return {
    id: web.id,
    title: web.title,
    artistId: `web:${web.provider}`,
    artist: web.artist,
    album: web.album ?? `${web.providerLabel} · web import`,
    year: Number.isNaN(added.getTime()) ? new Date().getFullYear() : added.getFullYear(),
    genres: [],
    moods: [],
    tags: ["web", web.provider, web.playbackKind],
    bpm: spec.bpm,
    musicalKey: "web",
    energy: 0.5,
    valence: 0.5,
    instrumental: true,
    duration: web.durationSec ?? 30,
    description: `${web.title} by ${web.artist}, imported from ${web.providerLabel}. ${web.notes ?? ""}`.trim(),
    soundsLike: [],
    palette: web.palette,
    spec,
    popularity: 0,
    web: {
      id: web.id,
      sourceUrl: web.sourceUrl,
      provider: web.provider,
      providerLabel: web.providerLabel,
      playbackKind: web.playbackKind,
      license: web.license,
      artworkUrl: web.artworkUrl,
    },
  };
}

/* ----------------------------------------------------------- persistence ---- */

export async function listWebTracks(): Promise<WebTrack[]> {
  const store = await readStore();
  return [...store.tracks].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
}

export async function getWebTrack(id: string): Promise<WebTrack | null> {
  if (!isWebTrackId(id)) return null;
  const store = await readStore();
  return store.tracks.find((track) => track.id === id) ?? null;
}

export async function getWebTracksByIds(ids: string[]): Promise<WebTrack[]> {
  const store = await readStore();
  const index = new Map(store.tracks.map((track) => [track.id, track]));
  return ids.map((id) => index.get(id)).filter((track): track is WebTrack => Boolean(track));
}

export interface SaveWebTrackInput {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationSec?: number;
  sourceUrl: string;
  audioUrl?: string;
  provider: string;
  providerLabel: string;
  playbackKind: PlaybackKind;
  license: string;
  notes?: string;
  palette?: [string, string];
}

/** Insert or refresh a web song. Idempotent — replays never duplicate rows. */
export async function saveWebTrack(input: SaveWebTrackInput): Promise<WebTrack> {
  const title = input.title.trim();
  const artist = input.artist.trim() || "Unknown artist";
  const sourceUrl = input.sourceUrl.trim();
  if (!title) throw new Error("A web track needs a title");
  if (!/^https?:\/\//i.test(sourceUrl) && !sourceUrl.startsWith("songhub://")) {
    throw new Error("A web track needs a real source URL");
  }

  const store = await readStore();
  const id = webTrackId(title, artist, sourceUrl);
  const now = new Date().toISOString();
  const existing = store.tracks.find((track) => track.id === id);

  if (existing) {
    const updated: WebTrack = {
      ...existing,
      // never lose a better resolution
      audioUrl: input.audioUrl ?? existing.audioUrl,
      playbackKind: input.audioUrl ? input.playbackKind : existing.playbackKind,
      license: input.audioUrl ? input.license : existing.license,
      durationSec: input.durationSec ?? existing.durationSec,
      artworkUrl: input.artworkUrl ?? existing.artworkUrl,
      album: input.album ?? existing.album,
      notes: input.notes ?? existing.notes,
      resolvedAt: input.audioUrl ? now : existing.resolvedAt,
    };
    const index = store.tracks.findIndex((track) => track.id === id);
    store.tracks[index] = updated;
    await writeStore(store);
    return updated;
  }

  const web: WebTrack = {
    id,
    title,
    artist,
    album: input.album,
    artworkUrl: input.artworkUrl,
    durationSec: input.durationSec,
    sourceUrl,
    audioUrl: input.audioUrl,
    provider: input.provider || "web",
    providerLabel: input.providerLabel || "Web",
    playbackKind: input.playbackKind,
    license: input.license,
    palette: input.palette ?? webPalette(`${title}|${artist}`),
    notes: input.notes,
    addedAt: now,
    resolvedAt: input.audioUrl ? now : undefined,
  };

  store.tracks.unshift(web);
  store.tracks = store.tracks.slice(0, MAX_WEB_TRACKS);
  await writeStore(store);
  return web;
}

export async function deleteWebTrack(id: string): Promise<boolean> {
  const store = await readStore();
  const next = store.tracks.filter((track) => track.id !== id);
  if (next.length === store.tracks.length) return false;
  store.tracks = next;
  await writeStore(store);
  return true;
}

/* ------------------------------------------------------------- resolving ---- */

export interface SaveWebHitOptions extends ResolveOptions {
  /** Skip the resolver when the hit already carries lawful audio. */
  skipResolve?: boolean;
}

/**
 * Save a search hit and resolve playable audio for it.
 * This is what "play" and "add to playlist" both call, so the playlist entry
 * always ends up with the real title, the real source URL and a working stream.
 */
export async function saveWebHit(hit: WebSearchHit, options: SaveWebHitOptions = {}): Promise<WebTrack> {
  const existing = await getWebTrack(webTrackId(hit.title, hit.artist, hit.sourceUrl));
  // Never trust a client-supplied audio URL unless it is a public https host.
  const hitAudioUrl = isSafeAudioUrl(hit.audioUrl) ? hit.audioUrl : undefined;

  const resolution: PlaybackResolution = options.skipResolve
    ? {
        audioUrl: hitAudioUrl ?? existing?.audioUrl,
        playbackKind: hit.playbackKind ?? existing?.playbackKind ?? "generated",
        license: existing?.license ?? "Openly published audio",
        audioProvider: hit.provider,
        audioProviderLabel: hit.provider,
      }
    : await resolvePlayback(
        { title: hit.title, artist: hit.artist, audioUrl: hitAudioUrl, provider: hit.provider },
        options,
      );

  const origin = hit.provider === "mp3juice" ? "Found on mp3juice.sc" : `Found via ${hit.providerLabel}`;
  return saveWebTrack({
    title: hit.title,
    artist: hit.artist,
    album: hit.album,
    artworkUrl: hit.artworkUrl,
    durationSec: hit.durationSec,
    sourceUrl: hit.sourceUrl,
    provider: hit.provider,
    providerLabel: hit.providerLabel,
    audioUrl: isSafeAudioUrl(resolution.audioUrl) ? resolution.audioUrl : undefined,
    playbackKind: resolution.playbackKind,
    license: resolution.license,
    notes: `${origin}. Playback: ${resolution.audioProviderLabel}.`,
  });
}

/** Catalog track or saved web track — whichever owns the id. */
export async function getPlayableTrack(id: string): Promise<Track | null> {
  const catalog = getTrack(id);
  if (catalog) return catalog;
  const web = await getWebTrack(id);
  return web ? webTrackToTrack(web) : null;
}

/** Resolve a mixed list of catalog + web ids into tracks, preserving order. */
export async function resolvePlayableTracks(ids: string[]): Promise<Track[]> {
  const webIds = ids.filter(isWebTrackId);
  const webTracks = webIds.length ? await getWebTracksByIds(webIds) : [];
  const webIndex = new Map(webTracks.map((track) => [track.id, webTrackToTrack(track)]));
  const out: Track[] = [];
  for (const id of ids) {
    const track = getTrack(id) ?? webIndex.get(id);
    if (track) out.push(track);
  }
  return out;
}

/** Keep only ids that can actually be played (catalog or saved web song). */
export async function filterPlayableIds(ids: string[]): Promise<string[]> {
  const webIds = new Set((await listWebTracks()).map((track) => track.id));
  return ids.filter((id) => Boolean(getTrack(id)) || webIds.has(id));
}

export async function isPlayableId(id: string): Promise<boolean> {
  if (getTrack(id)) return true;
  return Boolean(await getWebTrack(id));
}

/** Web-only view used by `/api/web/tracks` and the Library page. */
export async function listWebTracksAsTracks(): Promise<Track[]> {
  return (await listWebTracks()).map(webTrackToTrack);
}
