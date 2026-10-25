import { describe, expect, it } from "vitest";
import { search } from "@/lib/ai/search";
import { understandQuery } from "@/lib/ai/understand";
import { BOLLYWOOD_TRACKS, TRACKS } from "@/lib/catalog/tracks";
import { offlineResults } from "@/lib/online/sources";
import { offlineWebHits } from "@/lib/online/web";
import { renderTrack } from "@/lib/audio/synth";
import { estimateBytes, qualityOr } from "@/lib/audio/quality";

const top = (query: string, limit = 5) => search(query, { limit });

describe("Bollywood discovery", () => {
  it("finds the shelf from the word 'bollywood'", () => {
    const result = top("bollywood");
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) expect(hit.track.genres).toContain("bollywood");
    expect(result.understanding.filters.genres).toContain("bollywood");
  });

  it("treats 'hindi', 'filmi' and 'desi' as the same shelf", () => {
    for (const query of ["hindi songs", "filmi music", "desi songs", "bollywood gaane"]) {
      const result = top(query, 3);
      expect(result.hits.length, query).toBeGreaterThan(0);
      expect(result.hits[0].track.genres, query).toContain("bollywood");
    }
  });

  it("answers a romance request with Bollywood romance", () => {
    const result = top("bollywood love song", 5);
    expect(result.hits[0].track.moods).toContain("romantic");
    expect(result.hits[0].track.genres).toContain("bollywood");
  });

  it("puts sangeet/dance queries on the party tracks", () => {
    const result = top("sangeet dance song", 4);
    expect(result.hits[0].track.moods).toContain("energetic");
    expect(result.hits[0].track.tags.some((tag) => ["wedding", "dance", "party", "mehndi", "sangeet", "item song"].includes(tag))).toBe(true);
  });

  it("finds sufi material by qawwali/ghazal vocabulary", () => {
    const result = top("sufi qawwali", 4);
    expect(result.hits[0].track.genres).toContain("sufi");
    expect(result.hits.filter((hit) => hit.track.genres.includes("sufi")).length).toBeGreaterThanOrEqual(2);
  });

  it("understands monsoon/barsaat as rain music", () => {
    const result = top("monsoon barsaat song", 4);
    expect(result.hits[0].track.id).toBe("trk_baarish_ki_chaadar");
  });

  it("searches Devanagari titles", () => {
    const result = top("बारिश की चादर", 3);
    expect(result.hits[0].track.id).toBe("trk_baarish_ki_chaadar");
  });

  it("finds every Bollywood track by its own title", () => {
    for (const track of BOLLYWOOD_TRACKS) {
      const result = top(track.title, 3);
      expect(result.hits.some((hit) => hit.track.id === track.id), track.title).toBe(true);
    }
  });

  it("finds every Bollywood track by its Devanagari title", () => {
    for (const track of BOLLYWOOD_TRACKS) {
      const result = top(track.nativeTitle ?? track.title, 3);
      expect(result.hits.some((hit) => hit.track.id === track.id), track.nativeTitle).toBe(true);
    }
  });

  it("finds the filmi artists by name", () => {
    const artists = ["Bombay Transit", "Meher Kaul", "Saanjh Collective", "Ravi Deshmukh", "Zoya Qureshi", "Monsoon Cinema"];
    for (const artist of artists) {
      const result = top(artist, 3);
      expect(result.hits[0].track.artist, artist).toBe(artist);
    }
  });

  it("finds an artist even with a typo", () => {
    const result = top("Moonson Cinema", 3);
    expect(result.hits[0].track.artist).toBe("Monsoon Cinema");
  });

  it("survives a typo in a Hindi title", () => {
    const result = top("baarish ki chadar", 3);
    expect(result.hits[0].track.id).toBe("trk_baarish_ki_chaadar");
  });

  it("does not leak Bollywood into unrelated queries", () => {
    const result = top("minimal techno for coding", 3);
    expect(result.hits[0].track.genres).not.toContain("bollywood");
  });

  it("understands the filmi language tags", () => {
    const understanding = understandQuery("slow hindi filmi love songs from the 90s");
    expect(understanding.filters.genres).toContain("bollywood");
    expect(understanding.filters.maxBpm).toBeLessThanOrEqual(120);
  });

  it("reports Hindi film vocabulary in its reasoning", () => {
    const understanding = understandQuery("bollywood sangeet");
    expect(understanding.reasoning.join(" ").toLowerCase()).toMatch(/bollywood|genre/);
  });
});

describe("offline web search for Hindi film songs", () => {
  it("returns Hindi rows from the demo catalogue", () => {
    const results = offlineResults("baarish hindi song", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((row) => /Baarish|Mausam|Ishq|Rangreza/i.test(row.title))).toBe(true);
  });

  it("labels the offline web-music rows honestly", () => {
    const hits = offlineWebHits("bollywood", 4);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].notes).toContain("Offline demo");
  });
});

describe("Bollywood audio at every quality", () => {
  it("is audible and distinct at 22.05 kHz and 48 kHz", () => {
    const track = BOLLYWOOD_TRACKS[0];
    const low = renderTrack(track.spec, 22050);
    const high = renderTrack(track.spec, 48000);
    expect(high.length).toBeGreaterThan(low.length * 2);
    const peak = (samples: Float32Array) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    expect(peak(low)).toBeGreaterThan(0.05);
    expect(peak(high)).toBeGreaterThan(0.05);
  });

  it("gets cheaper to stream as the rung drops", () => {
    const track = BOLLYWOOD_TRACKS[0];
    const saver = estimateBytes(track.duration, qualityOr("mp3-64"));
    const lossless = estimateBytes(track.duration, qualityOr("wav-48-24"));
    expect(lossless).toBeGreaterThan(saver * 10);
  });

  it("keeps the catalogue's Hindi tracks out of the instrumental-only lie", () => {
    for (const track of BOLLYWOOD_TRACKS) {
      // Tags and the flag must agree, as the catalog contract requires.
      expect(track.tags.includes("instrumental")).toBe(track.instrumental);
      expect(TRACKS.find((entry) => entry.id === track.id)).toBeDefined();
    }
  });
});
