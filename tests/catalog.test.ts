import { describe, expect, it } from "vitest";
import {
  ARTISTS,
  ARTIST_BY_ID,
  SCALES,
  TRACKS,
  TRACK_BY_ID,
  getTrack,
  tracksOfArtist,
} from "@/lib/catalog/tracks";

const VALID_GENRES = ["lo-fi", "ambient", "synthwave", "indie", "jazz", "electronic", "acoustic", "hip-hop", "classical", "pop", "rock", "house"];
const VALID_MOODS = ["calm", "focused", "energetic", "melancholic", "uplifting", "dreamy", "dark", "romantic", "nostalgic", "triumphant"];

describe("catalog shape", () => {
  it("has at least 20 tracks", () => {
    expect(TRACKS.length).toBeGreaterThanOrEqual(20);
  });
  it("has at least 10 artists", () => {
    expect(ARTISTS.length).toBeGreaterThanOrEqual(10);
  });
  it("has unique track ids", () => {
    expect(new Set(TRACKS.map((t) => t.id)).size).toBe(TRACKS.length);
  });
  it("has unique titles", () => {
    expect(new Set(TRACKS.map((t) => t.title)).size).toBe(TRACKS.length);
  });
  it("has unique artist ids", () => {
    expect(new Set(ARTISTS.map((a) => a.id)).size).toBe(ARTISTS.length);
  });
  it("maps every track id through TRACK_BY_ID", () => {
    for (const track of TRACKS) expect(TRACK_BY_ID.get(track.id)).toBe(track);
  });
  it("maps every artist through ARTIST_BY_ID", () => {
    for (const artist of ARTISTS) expect(ARTIST_BY_ID.get(artist.id)).toBe(artist);
  });
  it("returns undefined for unknown ids", () => {
    expect(getTrack("nope")).toBeUndefined();
  });
  it("covers every genre", () => {
    const used = new Set(TRACKS.flatMap((t) => t.genres));
    for (const genre of VALID_GENRES) expect(used.has(genre as never), genre).toBe(true);
  });
  it("covers a broad set of moods", () => {
    const used = new Set(TRACKS.flatMap((t) => t.moods));
    expect(used.size).toBeGreaterThanOrEqual(8);
  });
});

describe("track integrity", () => {
  for (const track of TRACKS) {
    it(`${track.id}: has a non-empty title and artist`, () => {
      expect(track.title.length).toBeGreaterThan(2);
      expect(track.artist.length).toBeGreaterThan(2);
    });
    it(`${track.id}: belongs to a known artist`, () => {
      const artist = ARTIST_BY_ID.get(track.artistId);
      expect(artist).toBeDefined();
      expect(artist?.name).toBe(track.artist);
    });
    it(`${track.id}: has valid genres`, () => {
      expect(track.genres.length).toBeGreaterThan(0);
      for (const genre of track.genres) expect(VALID_GENRES).toContain(genre);
    });
    it(`${track.id}: has valid moods`, () => {
      expect(track.moods.length).toBeGreaterThan(0);
      for (const mood of track.moods) expect(VALID_MOODS).toContain(mood);
    });
    it(`${track.id}: has descriptive tags`, () => {
      expect(track.tags.length).toBeGreaterThanOrEqual(4);
    });
    it(`${track.id}: has a sensible bpm`, () => {
      expect(track.bpm).toBeGreaterThanOrEqual(40);
      expect(track.bpm).toBeLessThanOrEqual(200);
    });
    it(`${track.id}: energy and valence are in [0,1]`, () => {
      expect(track.energy).toBeGreaterThanOrEqual(0);
      expect(track.energy).toBeLessThanOrEqual(1);
      expect(track.valence).toBeGreaterThanOrEqual(0);
      expect(track.valence).toBeLessThanOrEqual(1);
    });
    it(`${track.id}: duration matches its spec`, () => {
      const expected = (track.spec.bars * 4 * 60) / track.spec.bpm;
      expect(Math.abs(track.duration - expected)).toBeLessThan(1);
    });
    it(`${track.id}: popularity is a percentage`, () => {
      expect(track.popularity).toBeGreaterThan(0);
      expect(track.popularity).toBeLessThanOrEqual(100);
    });
    it(`${track.id}: has a written description`, () => {
      expect(track.description.length).toBeGreaterThan(40);
    });
    it(`${track.id}: has at least three "sounds like" references`, () => {
      expect(track.soundsLike.length).toBeGreaterThanOrEqual(3);
      for (const ref of track.soundsLike) expect(ref.length).toBeGreaterThan(2);
    });
    it(`${track.id}: has a two-colour palette`, () => {
      expect(track.palette).toHaveLength(2);
      for (const colour of track.palette) expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    });
    it(`${track.id}: uses a valid musical key label`, () => {
      expect(track.musicalKey).toMatch(/^[A-G]#?\d (minor|major|dorian|lydian|phrygian|pentatonic)$/);
    });
    it(`${track.id}: has a playable spec`, () => {
      expect(track.spec.bars).toBeGreaterThan(4);
      expect(track.spec.progression.length).toBeGreaterThan(0);
      expect(Object.values(track.spec.voices).some(Boolean)).toBe(true);
    });
    it(`${track.id}: scale matches a known scale`, () => {
      const known = Object.values(SCALES).map((s) => JSON.stringify([...s]));
      expect(known).toContain(JSON.stringify(track.spec.scale));
    });
    it(`${track.id}: year is plausible`, () => {
      expect(track.year).toBeGreaterThanOrEqual(1990);
      expect(track.year).toBeLessThanOrEqual(2026);
    });
    it(`${track.id}: instrumental flag matches its tags`, () => {
      const taggedInstrumental = track.tags.includes("instrumental");
      expect(taggedInstrumental).toBe(track.instrumental);
    });
  }
});

describe("artist integrity", () => {
  for (const artist of ARTISTS) {
    it(`${artist.id}: has a bio and country`, () => {
      expect(artist.bio.length).toBeGreaterThan(20);
      expect(artist.country).toMatch(/^[A-Z]{2}$/);
    });
    it(`${artist.id}: has a palette`, () => {
      expect(artist.palette).toHaveLength(2);
    });
    it(`${artist.id}: has a track in the catalog`, () => {
      expect(tracksOfArtist(artist.id).length).toBeGreaterThan(0);
    });
    it(`${artist.id}: genres overlap with its tracks`, () => {
      const trackGenres = new Set(tracksOfArtist(artist.id).flatMap((t) => t.genres));
      expect(artist.genres.some((g) => trackGenres.has(g))).toBe(true);
    });
  }
});

describe("catalog balance", () => {
  it("has a mix of instrumental and vocal tracks", () => {
    const instrumental = TRACKS.filter((t) => t.instrumental).length;
    expect(instrumental).toBeGreaterThan(5);
    expect(TRACKS.length - instrumental).toBeGreaterThan(5);
  });
  it("spans a wide tempo range", () => {
    const bpms = TRACKS.map((t) => t.bpm);
    expect(Math.min(...bpms)).toBeLessThan(70);
    expect(Math.max(...bpms)).toBeGreaterThan(120);
  });
  it("gives a decent total listening time", () => {
    const minutes = TRACKS.reduce((sum, t) => sum + t.duration, 0) / 60;
    expect(minutes).toBeGreaterThan(30);
  });
  it("has no duplicate titles ignoring case", () => {
    const lower = TRACKS.map((t) => t.title.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
  it("uses at least eight distinct artist palettes", () => {
    expect(new Set(ARTISTS.map((a) => a.palette.join())).size).toBeGreaterThanOrEqual(8);
  });
  it("has at least three years represented per decade", () => {
    const decades = new Map<number, number>();
    for (const t of TRACKS) {
      const d = Math.floor(t.year / 10) * 10;
      decades.set(d, (decades.get(d) ?? 0) + 1);
    }
    expect(decades.size).toBeGreaterThanOrEqual(2);
  });
});
