/**
 * Personal layer: liked tracks, playlists, play events, analytics and radio.
 * Persisted as JSON under `.data/` so it survives restarts without a database.
 */

import type { AnalyticsSummary, PlayEvent, Playlist, SearchHit, Track } from "../types";
import { TRACKS, getTrack } from "../catalog/tracks";
import { readJson, writeJson } from "../storage";
import { hashString, uid } from "../util";
import { similarTracks } from "../ai/search";

const PLAYLISTS_FILE = "playlists.json";
const LIBRARY_FILE = "library.json";
const EVENTS_FILE = "events.json";

export interface LibraryState {
  liked: string[];
  recent: string[];
  /** trackId -> play counts, used by the recommender. */
  plays: Record<string, number>;
  updatedAt: string;
}

const EMPTY_LIBRARY: LibraryState = { liked: [], recent: [], plays: {}, updatedAt: new Date(0).toISOString() };

export async function getLibrary(): Promise<LibraryState> {
  return readJson<LibraryState>(LIBRARY_FILE, EMPTY_LIBRARY);
}

export async function toggleLike(trackId: string): Promise<{ liked: boolean; library: LibraryState }> {
  if (!getTrack(trackId)) throw new Error(`Unknown track: ${trackId}`);
  const library = await getLibrary();
  const index = library.liked.indexOf(trackId);
  if (index >= 0) library.liked.splice(index, 1);
  else library.liked.unshift(trackId);
  library.updatedAt = new Date().toISOString();
  await writeJson(LIBRARY_FILE, library);
  return { liked: index < 0, library };
}

/* --------------------------------------------------------- play events ---- */

export interface StoredEvent extends PlayEvent {}

export async function recordPlay(input: Omit<PlayEvent, "id" | "playedAt"> & { playedAt?: string }): Promise<PlayEvent> {
  const events = await readJson<StoredEvent[]>(EVENTS_FILE, []);
  const event: PlayEvent = {
    id: uid("ev"),
    trackId: input.trackId,
    playedAt: input.playedAt ?? new Date().toISOString(),
    msPlayed: Math.max(0, Math.round(input.msPlayed)),
    source: input.source,
  };
  events.push(event);
  // keep the last 5000 events; this is a personal app, not a data warehouse
  const trimmed = events.slice(-5000);
  await writeJson(EVENTS_FILE, trimmed);

  const library = await getLibrary();
  library.plays[event.trackId] = (library.plays[event.trackId] ?? 0) + 1;
  library.recent = [event.trackId, ...library.recent.filter((id) => id !== event.trackId)].slice(0, 40);
  library.updatedAt = event.playedAt;
  await writeJson(LIBRARY_FILE, library);

  return event;
}

export async function getEvents(): Promise<PlayEvent[]> {
  return readJson<PlayEvent[]>(EVENTS_FILE, []);
}

/* ------------------------------------------------------------ playlists ---- */

export async function getPlaylists(): Promise<Playlist[]> {
  return readJson<Playlist[]>(PLAYLISTS_FILE, []);
}

export interface CreatePlaylistInput {
  name: string;
  description?: string;
  trackIds: string[];
  aiGenerated?: boolean;
  palette?: [string, string];
}

export async function createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
  const playlists = await getPlaylists();
  const now = new Date().toISOString();
  const palette = input.palette ?? paletteFromName(input.name);
  const playlist: Playlist = {
    id: uid("pl"),
    name: input.name.trim() || "Untitled playlist",
    description: input.description?.trim() || "Made in SongHub",
    trackIds: input.trackIds.filter((id) => Boolean(getTrack(id))),
    owner: "you",
    createdAt: now,
    updatedAt: now,
    aiGenerated: Boolean(input.aiGenerated),
    palette,
  };
  playlists.unshift(playlist);
  await writeJson(PLAYLISTS_FILE, playlists);
  return playlist;
}

export async function updatePlaylist(id: string, patch: Partial<Pick<Playlist, "name" | "description" | "trackIds">>): Promise<Playlist | null> {
  const playlists = await getPlaylists();
  const index = playlists.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const current = playlists[index];
  const next: Playlist = {
    ...current,
    ...patch,
    trackIds: (patch.trackIds ?? current.trackIds).filter((tid) => Boolean(getTrack(tid))),
    updatedAt: new Date().toISOString(),
  };
  playlists[index] = next;
  await writeJson(PLAYLISTS_FILE, playlists);
  return next;
}

export async function deletePlaylist(id: string): Promise<boolean> {
  const playlists = await getPlaylists();
  const next = playlists.filter((p) => p.id !== id);
  if (next.length === playlists.length) return false;
  await writeJson(PLAYLISTS_FILE, next);
  return true;
}

export function paletteFromName(name: string): [string, string] {
  const h = hashString(name);
  const hue = h % 360;
  const hue2 = (hue + 40 + (h % 60)) % 360;
  return [`hsl(${hue} 85% 58%)`, `hsl(${hue2} 70% 32%)`];
}

/** Seed playlists created on first run so the app never looks empty. */
export const SEED_PLAYLISTS: CreatePlaylistInput[] = [
  {
    name: "Deep Focus",
    description: "Low-vocal, steady-state loops for long writing sessions.",
    trackIds: ["trk_study_loop_7", "trk_koi_pond_morning", "trk_rain_on_the_tram", "trk_broken_clock_band", "trk_glacier_letters", "trk_deep_house_dawn"],
    palette: ["#59d4b5", "#123f3a"],
  },
  {
    name: "Night Drive",
    description: "Neon, arpeggios and wet asphalt.",
    trackIds: ["trk_neon_overpass", "trk_aurora_drive", "trk_saltwater_radio", "trk_chrome_heartbeat", "trk_violet_hours"],
    palette: ["#ff2d95", "#3a1c71"],
  },
  {
    name: "Rainy Sunday",
    description: "Acoustic, unhurried, slightly sad.",
    trackIds: ["trk_paper_boats", "trk_orchard_lullaby", "trk_riverbend", "trk_afterglow_piano", "trk_cloud_sofa"],
    palette: ["#7ec8e3", "#0b2545"],
  },
  {
    name: "Golden Hour",
    description: "Sun on the walls, windows down.",
    trackIds: ["trk_golden_hour", "trk_summer_handwriting", "trk_velvet_morning", "trk_glass_aster", "trk_headlights_home"],
    palette: ["#f6d365", "#fda085"],
  },
];

export async function ensureSeedPlaylists(): Promise<Playlist[]> {
  const existing = await getPlaylists();
  if (existing.length) return existing;
  const created: Playlist[] = [];
  for (const seed of SEED_PLAYLISTS) created.push(await createPlaylist({ ...seed, aiGenerated: false }));
  return getPlaylists();
}

/* ------------------------------------------------------------ analytics ---- */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function summariseAnalytics(events: PlayEvent[], library: LibraryState): AnalyticsSummary {
  const trackPlays = new Map<string, number>();
  const artistPlays = new Map<string, number>();
  const genrePlays = new Map<string, number>();
  const moodPlays = new Map<string, number>();
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, plays: 0 }));
  const dayMap = new Map<string, number>();
  const days = new Set<string>();
  let totalMs = 0;

  for (const event of events) {
    const track = getTrack(event.trackId);
    if (!track) continue;
    trackPlays.set(track.id, (trackPlays.get(track.id) ?? 0) + 1);
    artistPlays.set(track.artist, (artistPlays.get(track.artist) ?? 0) + 1);
    for (const g of track.genres) genrePlays.set(g, (genrePlays.get(g) ?? 0) + 1);
    for (const m of track.moods) moodPlays.set(m, (moodPlays.get(m) ?? 0) + 1);
    totalMs += event.msPlayed;
    const when = new Date(event.playedAt);
    if (!Number.isNaN(when.getTime())) {
      byHour[when.getHours()].plays++;
      const key = when.toISOString().slice(0, 10);
      days.add(key);
      const dayName = DAY_NAMES[when.getDay()];
      dayMap.set(dayName, (dayMap.get(dayName) ?? 0) + 1);
    }
  }

  const topTracks = [...trackPlays.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, plays]) => ({ track: getTrack(id)!, plays }))
    .filter((entry) => Boolean(entry.track));

  const top = (map: Map<string, number>, limit = 6) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  return {
    totalPlays: events.length,
    minutesListened: Math.round((totalMs / 60000) * 10) / 10,
    uniqueTracks: trackPlays.size,
    topTracks,
    topArtists: top(artistPlays).map(([artist, plays]) => ({ artist, plays })),
    topGenres: top(genrePlays).map(([genre, plays]) => ({ genre, plays })),
    topMoods: top(moodPlays).map(([mood, plays]) => ({ mood, plays })),
    byHour,
    byDay: DAY_NAMES.map((day) => ({ day, plays: dayMap.get(day) ?? 0 })),
    streakDays: longestStreak([...days].sort()),
  };
}

/** Number of consecutive days (ending today or yesterday) with at least one play. */
export function longestStreak(sortedDays: string[], today = new Date()): number {
  if (!sortedDays.length) return 0;
  const set = new Set(sortedDays);
  const cursor = new Date(today);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (!set.has(iso(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!set.has(iso(cursor))) return 0;
  }
  let streak = 0;
  while (set.has(iso(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* ------------------------------------------------------------- taste ---- */

export function tasteProfileFrom(library: LibraryState, events: PlayEvent[]): { genres: string[]; moods: string[]; artistIds: string[] } {
  const genreCount = new Map<string, number>();
  const moodCount = new Map<string, number>();
  const artistCount = new Map<string, number>();

  const consider = (trackId: string, weight: number) => {
    const track = getTrack(trackId);
    if (!track) return;
    for (const g of track.genres) genreCount.set(g, (genreCount.get(g) ?? 0) + weight);
    for (const m of track.moods) moodCount.set(m, (moodCount.get(m) ?? 0) + weight);
    artistCount.set(track.artistId, (artistCount.get(track.artistId) ?? 0) + weight);
  };

  for (const id of library.liked) consider(id, 3);
  for (const id of library.recent) consider(id, 1);
  for (const [id, count] of Object.entries(library.plays)) consider(id, Math.min(count, 5));

  const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return { genres: top(genreCount), moods: top(moodCount), artistIds: top(artistCount) };
}

/* ------------------------------------------------------------- radio ---- */

/**
 * Endless radio: seed-relative similarity, nudged by taste and de-duplicated.
 * Produces a stable ordering for a given seed so it behaves like a station.
 */
export function buildRadio(seedId: string | null, taste: { genres: string[]; moods: string[] }, limit = 20): Track[] {
  const seed = seedId ? getTrack(seedId) : undefined;
  const base = seed ? seed : TRACKS[Math.floor(Math.random() * TRACKS.length)];
  const ranked = similarTracks(base.id, TRACKS.length);

  const scored = ranked.map(({ track, score }) => {
    let adjusted = score;
    if (taste.genres.some((g) => track.genres.includes(g as never))) adjusted += 0.05;
    if (taste.moods.some((m) => track.moods.includes(m as never))) adjusted += 0.03;
    if (track.artistId === base.artistId) adjusted -= 0.02;
    return { track, score: adjusted };
  });

  scored.sort((a, b) => b.score - a.score);
  const out: Track[] = [base, ...scored.map((s) => s.track)];
  return out.slice(0, limit);
}

/** Turn search hits into a playable queue. */
export function queueFromHits(hits: SearchHit[]): Track[] {
  return hits.map((h) => h.track);
}
