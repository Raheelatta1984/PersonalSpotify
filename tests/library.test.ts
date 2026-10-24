import { beforeAll, describe, expect, it } from "vitest";
import {
  SEED_PLAYLISTS,
  buildRadio,
  createPlaylist,
  deletePlaylist,
  ensureSeedPlaylists,
  getEvents,
  getLibrary,
  getPlaylists,
  longestStreak,
  paletteFromName,
  queueFromHits,
  recordPlay,
  summariseAnalytics,
  tasteProfileFrom,
  toggleLike,
  updatePlaylist,
} from "@/lib/store/library";
import { TRACKS, getTrack } from "@/lib/catalog/tracks";
import { search } from "@/lib/ai/search";
import type { PlayEvent } from "@/lib/types";

async function resetState() {
  const playlists = await getPlaylists();
  for (const playlist of playlists) await deletePlaylist(playlist.id);
  const library = await getLibrary();
  for (const id of [...library.liked]) await toggleLike(id);
}

describe("likes", () => {
  beforeAll(resetState, 60000);

  it("starts empty", async () => {
    expect((await getLibrary()).liked).toHaveLength(0);
  });
  it("likes a track", async () => {
    const result = await toggleLike(TRACKS[0].id);
    expect(result.liked).toBe(true);
    expect(result.library.liked).toContain(TRACKS[0].id);
  });
  it("unlikes the same track", async () => {
    const result = await toggleLike(TRACKS[0].id);
    expect(result.liked).toBe(false);
    expect(result.library.liked).not.toContain(TRACKS[0].id);
  });
  it("rejects unknown tracks", async () => {
    await expect(toggleLike("nope")).rejects.toThrow();
  });
  it("keeps liked order newest-first", async () => {
    await toggleLike(TRACKS[1].id);
    await toggleLike(TRACKS[2].id);
    const library = await getLibrary();
    expect(library.liked[0]).toBe(TRACKS[2].id);
    expect(library.liked[1]).toBe(TRACKS[1].id);
  });
});

describe("play events", () => {
  beforeAll(resetState, 60000);

  it("records a play", async () => {
    const event = await recordPlay({ trackId: TRACKS[0].id, msPlayed: 1234, source: "search" });
    expect(event.id).toMatch(/^ev_/);
    expect(event.trackId).toBe(TRACKS[0].id);
    expect(event.msPlayed).toBe(1234);
  });
  it("persists events", async () => {
    const events = await getEvents();
    expect(events.length).toBeGreaterThan(0);
  });
  it("updates the library play count", async () => {
    const library = await getLibrary();
    expect(library.plays[TRACKS[0].id]).toBeGreaterThan(0);
  });
  it("puts the track at the top of recent", async () => {
    await recordPlay({ trackId: TRACKS[5].id, msPlayed: 500, source: "home" });
    expect((await getLibrary()).recent[0]).toBe(TRACKS[5].id);
  });
  it("does not duplicate recent entries", async () => {
    await recordPlay({ trackId: TRACKS[5].id, msPlayed: 500, source: "home" });
    const recent = (await getLibrary()).recent;
    expect(recent.filter((id) => id === TRACKS[5].id)).toHaveLength(1);
  });
  it("accepts a custom timestamp", async () => {
    const when = new Date("2024-01-02T03:04:05.000Z").toISOString();
    const event = await recordPlay({ trackId: TRACKS[3].id, msPlayed: 100, source: "queue", playedAt: when });
    expect(event.playedAt).toBe(when);
  });
  it("never stores negative listen time", async () => {
    const event = await recordPlay({ trackId: TRACKS[4].id, msPlayed: -500, source: "queue" });
    expect(event.msPlayed).toBe(0);
  });
});

describe("playlists", () => {
  beforeAll(resetState, 60000);

  it("creates a playlist", async () => {
    const playlist = await createPlaylist({
      name: "Test Mix",
      description: "for tests",
      trackIds: [TRACKS[0].id, TRACKS[1].id],
    });
    expect(playlist.id).toMatch(/^pl_/);
    expect(playlist.trackIds).toHaveLength(2);
    expect(playlist.owner).toBe("you");
    expect(playlist.aiGenerated).toBe(false);
  });
  it("lists playlists", async () => {
    expect((await getPlaylists()).length).toBe(1);
  });
  it("filters out unknown tracks", async () => {
    const playlist = await createPlaylist({ name: "Mixed", trackIds: [TRACKS[0].id, "ghost"] });
    expect(playlist.trackIds).toEqual([TRACKS[0].id]);
  });
  it("falls back to a default name", async () => {
    const playlist = await createPlaylist({ name: "   ", trackIds: [] });
    expect(playlist.name).toBe("Untitled playlist");
  });
  it("updates the name and tracks", async () => {
    const created = await createPlaylist({ name: "Before", trackIds: [TRACKS[0].id] });
    const updated = await updatePlaylist(created.id, { name: "After", trackIds: [TRACKS[2].id] });
    expect(updated?.name).toBe("After");
    expect(updated?.trackIds).toEqual([TRACKS[2].id]);
  });
  it("advances updatedAt on edit", async () => {
    const created = await createPlaylist({ name: "Clock", trackIds: [] });
    const updated = await updatePlaylist(created.id, { name: "Clock 2" });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
  });
  it("returns null when updating a missing playlist", async () => {
    expect(await updatePlaylist("pl_missing", { name: "x" })).toBeNull();
  });
  it("deletes a playlist", async () => {
    const created = await createPlaylist({ name: "Doomed", trackIds: [] });
    expect(await deletePlaylist(created.id)).toBe(true);
    expect(await deletePlaylist(created.id)).toBe(false);
  });
  it("generates a deterministic palette from a name", () => {
    expect(paletteFromName("Deep Focus")).toEqual(paletteFromName("Deep Focus"));
    expect(paletteFromName("Deep Focus")).not.toEqual(paletteFromName("Night Drive"));
  });
  it("produces hsl colours", () => {
    for (const colour of paletteFromName("anything")) expect(colour).toMatch(/^hsl\(/);
  });
  it("marks AI playlists", async () => {
    const playlist = await createPlaylist({ name: "AI made", trackIds: [], aiGenerated: true });
    expect(playlist.aiGenerated).toBe(true);
  });
});

describe("seed playlists", () => {
  beforeAll(resetState, 60000);

  it("creates the seed playlists on first run", async () => {
    const playlists = await ensureSeedPlaylists();
    expect(playlists.length).toBe(SEED_PLAYLISTS.length);
  });
  it("does not duplicate them on the second call", async () => {
    await ensureSeedPlaylists();
    expect((await getPlaylists()).length).toBe(SEED_PLAYLISTS.length);
  });
  it("only references real tracks", async () => {
    for (const playlist of await getPlaylists()) {
      for (const id of playlist.trackIds) expect(getTrack(id)).toBeDefined();
    }
  });
});

describe("analytics", () => {
  const events: PlayEvent[] = [
    { id: "1", trackId: TRACKS[0].id, playedAt: "2024-03-01T10:00:00.000Z", msPlayed: 120000, source: "home" },
    { id: "2", trackId: TRACKS[0].id, playedAt: "2024-03-01T11:00:00.000Z", msPlayed: 60000, source: "home" },
    { id: "3", trackId: TRACKS[1].id, playedAt: "2024-03-02T22:00:00.000Z", msPlayed: 30000, source: "search" },
  ];

  it("counts total plays", () => {
    expect(summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" }).totalPlays).toBe(3);
  });
  it("sums listening minutes", () => {
    expect(summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" }).minutesListened).toBeCloseTo(3.5, 1);
  });
  it("ranks top tracks", () => {
    const summary = summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" });
    expect(summary.topTracks[0].track.id).toBe(TRACKS[0].id);
    expect(summary.topTracks[0].plays).toBe(2);
  });
  it("ranks top artists", () => {
    const summary = summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" });
    expect(summary.topArtists[0].artist).toBe(TRACKS[0].artist);
  });
  it("buckets by hour", () => {
    const summary = summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" });
    const total = summary.byHour.reduce((sum, h) => sum + h.plays, 0);
    expect(total).toBe(3);
  });
  it("buckets by weekday", () => {
    const summary = summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" });
    expect(summary.byDay.reduce((sum, d) => sum + d.plays, 0)).toBe(3);
  });
  it("counts unique tracks", () => {
    expect(summariseAnalytics(events, { liked: [], recent: [], plays: {}, updatedAt: "" }).uniqueTracks).toBe(2);
  });
  it("ignores unknown tracks", () => {
    const summary = summariseAnalytics(
      [{ id: "x", trackId: "ghost", playedAt: new Date().toISOString(), msPlayed: 1000, source: "queue" }],
      { liked: [], recent: [], plays: {}, updatedAt: "" },
    );
    expect(summary.totalPlays).toBe(1);
    expect(summary.topTracks).toHaveLength(0);
  });
  it("handles an empty history", () => {
    const summary = summariseAnalytics([], { liked: [], recent: [], plays: {}, updatedAt: "" });
    expect(summary.totalPlays).toBe(0);
    expect(summary.streakDays).toBe(0);
  });
});

describe("streaks", () => {
  const today = new Date("2024-05-10T12:00:00.000Z");
  it("counts a single day", () => {
    expect(longestStreak(["2024-05-10"], today)).toBe(1);
  });
  it("counts consecutive days", () => {
    expect(longestStreak(["2024-05-08", "2024-05-09", "2024-05-10"], today)).toBe(3);
  });
  it("stops at a gap", () => {
    expect(longestStreak(["2024-05-01", "2024-05-09", "2024-05-10"], today)).toBe(2);
  });
  it("allows a streak ending yesterday", () => {
    expect(longestStreak(["2024-05-08", "2024-05-09"], today)).toBe(2);
  });
  it("is zero for a stale streak", () => {
    expect(longestStreak(["2024-04-01"], today)).toBe(0);
  });
  it("is zero without data", () => {
    expect(longestStreak([], today)).toBe(0);
  });
});

describe("taste profile", () => {
  it("derives genres and moods from likes", () => {
    const track = TRACKS.find((t) => t.genres.includes("lo-fi"))!;
    const taste = tasteProfileFrom({ liked: [track.id], recent: [], plays: {}, updatedAt: "" }, []);
    expect(taste.genres).toContain("lo-fi");
  });
  it("weights likes above plays", () => {
    const lofi = TRACKS.find((t) => t.genres.includes("lo-fi"))!;
    const rock = TRACKS.find((t) => t.genres.includes("rock"))!;
    const taste = tasteProfileFrom(
      { liked: [lofi.id], recent: [], plays: { [rock.id]: 1 }, updatedAt: "" },
      [],
    );
    expect(taste.genres[0]).toBe("lo-fi");
  });
  it("returns at most three of each", () => {
    const taste = tasteProfileFrom(
      { liked: TRACKS.map((t) => t.id), recent: [], plays: {}, updatedAt: "" },
      [],
    );
    expect(taste.genres.length).toBeLessThanOrEqual(3);
    expect(taste.moods.length).toBeLessThanOrEqual(3);
    expect(taste.artistIds.length).toBeLessThanOrEqual(3);
  });
});

describe("radio", () => {
  it("starts from the seed", () => {
    const radio = buildRadio(TRACKS[0].id, { genres: [], moods: [] }, 10);
    expect(radio[0].id).toBe(TRACKS[0].id);
  });
  it("returns the requested length", () => {
    expect(buildRadio(TRACKS[1].id, { genres: [], moods: [] }, 12)).toHaveLength(12);
  });
  it("never repeats a track", () => {
    const radio = buildRadio(TRACKS[2].id, { genres: [], moods: [] }, 20);
    expect(new Set(radio.map((t) => t.id)).size).toBe(radio.length);
  });
  it("works without a seed", () => {
    const radio = buildRadio(null, { genres: ["lo-fi"], moods: ["calm"] }, 5);
    expect(radio).toHaveLength(5);
  });
  it("prefers matching taste genres", () => {
    const radio = buildRadio(TRACKS[0].id, { genres: ["ambient"], moods: ["calm"] }, 15);
    const ambientCount = radio.filter((t) => t.genres.includes("ambient")).length;
    expect(ambientCount).toBeGreaterThan(0);
  });
  it("caps at the catalog size", () => {
    expect(buildRadio(TRACKS[0].id, { genres: [], moods: [] }, 999)).toHaveLength(TRACKS.length);
  });
});

describe("queue helpers", () => {
  it("turns hits into a queue in order", () => {
    const hits = search("rain", { limit: 4 }).hits;
    const queue = queueFromHits(hits);
    expect(queue.map((t) => t.id)).toEqual(hits.map((h) => h.track.id));
  });
  it("handles an empty result set", () => {
    expect(queueFromHits([])).toEqual([]);
  });
});
