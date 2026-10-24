import { beforeAll, describe, expect, it } from "vitest";
import { getIndex, buildIndex, lexicalScore, resetIndex, similarDocs } from "@/lib/ai/index";
import { embedText, embedTrack, cosine, l2Normalise, EMBED_DIM, conceptProfile } from "@/lib/ai/embed";
import { understandQuery, getNegativeSignals } from "@/lib/ai/understand";
import { buildAnswer, matchesFilters, rankTracks, search, similarTracks, groupByGenre } from "@/lib/ai/search";
import { TRACKS } from "@/lib/catalog/tracks";

const titles = (results: { track: { title: string } }[]) => results.map((r) => r.track.title);

describe("index", () => {
  beforeAll(() => resetIndex());

  it("indexes every track", () => {
    expect(getIndex().docs).toHaveLength(TRACKS.length);
  });
  it("computes document frequencies", () => {
    expect(getIndex().df.size).toBeGreaterThan(200);
  });
  it("has a positive average document length", () => {
    expect(getIndex().avgLength).toBeGreaterThan(0);
  });
  it("builds quickly", () => {
    expect(buildIndex().buildMs).toBeLessThan(2000);
  });
  it("is memoised", () => {
    expect(getIndex()).toBe(getIndex());
  });
  it("attaches a unit-length embedding to each doc", () => {
    for (const doc of getIndex().docs) {
      const norm = Math.sqrt(doc.vector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });
  it("scores a title term above an unrelated term", () => {
    const index = getIndex();
    const doc = index.docs.find((d) => d.track.id === "trk_neon_overpass")!;
    expect(lexicalScore(index, doc, ["neon"]).score).toBeGreaterThan(lexicalScore(index, doc, ["yodel"]).score);
  });
  it("tolerates a typo via fuzzy rescue", () => {
    const index = getIndex();
    const doc = index.docs.find((d) => d.track.id === "trk_neon_overpass")!;
    const result = lexicalScore(index, doc, ["ovaspass"]);
    expect(result.fuzzyTerms.length + result.matchedTerms.length).toBeGreaterThan(0);
  });
  it("suggests similar documents by vector", () => {
    const similar = similarDocs(getIndex(), "trk_neon_overpass", 5);
    expect(similar).toHaveLength(5);
    expect(similar[0].score).toBeGreaterThan(similar[4].score);
  });
});

describe("embeddings", () => {
  it("has a fixed dimension", () => {
    expect(embedText("hello").length).toBe(EMBED_DIM);
  });
  it("is deterministic", () => {
    expect(Array.from(embedText("warm lo-fi"))).toEqual(Array.from(embedText("warm lo-fi")));
  });
  it("is L2 normalised", () => {
    const vec = embedText("neon synth night drive");
    expect(Math.sqrt(vec.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 5);
  });
  it("scores identical text as maximally similar", () => {
    expect(cosine(embedText("rainy jazz"), embedText("rainy jazz"))).toBeCloseTo(1, 6);
  });
  it("scores related text above unrelated text", () => {
    const q = embedText("music to focus while coding");
    const focus = embedTrack(TRACKS.find((t) => t.id === "trk_study_loop_7")!);
    const party = embedTrack(TRACKS.find((t) => t.id === "trk_glass_aster")!);
    expect(cosine(q, focus)).toBeGreaterThan(cosine(q, party));
  });
  it("places lo-fi queries closer to lo-fi tracks", () => {
    const q = embedText("dusty lo-fi beats");
    const lofi = embedTrack(TRACKS.find((t) => t.id === "trk_rain_on_the_tram")!);
    const rock = embedTrack(TRACKS.find((t) => t.id === "trk_headlights_home")!);
    expect(cosine(q, lofi)).toBeGreaterThan(cosine(q, rock));
  });
  it("extracts concept profiles", () => {
    const profile = conceptProfile("something to help me study");
    expect(profile.get("focus")).toBeGreaterThan(0);
  });
  it("normalises zero vectors safely", () => {
    const zero = new Float32Array(EMBED_DIM);
    expect(Array.from(l2Normalise(zero)).every((v) => v === 0)).toBe(true);
  });
  it("produces different vectors for different tracks", () => {
    const a = embedTrack(TRACKS[0]);
    const b = embedTrack(TRACKS[1]);
    expect(cosine(a, b)).toBeLessThan(0.999);
  });
});

describe("query understanding", () => {
  it("detects genres", () => {
    expect(understandQuery("some lo-fi please").filters.genres).toContain("lo-fi");
  });
  it("detects moods", () => {
    expect(understandQuery("something really calm").filters.moods).toContain("calm");
  });
  it("detects instrumental intent", () => {
    expect(understandQuery("instrumental study music").filters.instrumental).toBe(true);
  });
  it("detects vocal intent", () => {
    expect(understandQuery("happy songs with vocals").filters.instrumental).toBe(false);
  });
  it("handles 'nothing with vocals'", () => {
    const u = understandQuery("warm and slow, nothing with vocals");
    expect(u.filters.instrumental).toBe(true);
    expect(getNegativeSignals(u)).toContain("vocals");
  });
  it("handles 'no rap'", () => {
    const u = understandQuery("chill beats, no rap");
    expect(getNegativeSignals(u)).toContain("rap");
  });
  it("parses explicit bpm", () => {
    const u = understandQuery("something at 120 bpm");
    expect(u.filters.minBpm).toBe(108);
    expect(u.filters.maxBpm).toBe(132);
  });
  it("maps 'fast' to a high tempo band", () => {
    expect(understandQuery("fast energetic").filters.minBpm).toBeGreaterThanOrEqual(105);
  });
  it("negates 'not too fast'", () => {
    const u = understandQuery("not too fast");
    expect(u.filters.maxBpm).toBeLessThanOrEqual(108);
    expect(u.negativeTokens).toContain("fast");
  });
  it("parses decades", () => {
    expect(understandQuery("music from the 90s").filters.decade).toBe(1990);
  });
  it("parses explicit years into a decade", () => {
    expect(understandQuery("tracks from 2023").filters.decade).toBe(2020);
  });
  it("detects play intent", () => {
    expect(understandQuery("play something chill").instructions.play).toBe(true);
  });
  it("detects playlist intent", () => {
    expect(understandQuery("make me a playlist of jazz").instructions.createPlaylist).toBe(true);
  });
  it("detects shuffle intent", () => {
    expect(understandQuery("shuffle my night drive mix").instructions.shuffle).toBe(true);
  });
  it("parses a numeric limit", () => {
    expect(understandQuery("top 5 calm tracks").instructions.limit).toBe(5);
  });
  it("clamps an absurd limit", () => {
    expect(understandQuery("top 99 calm tracks").instructions.limit).toBe(30);
  });
  it("finds an exact title reference", () => {
    expect(understandQuery("neon overpass").seedTitles).toContain("Neon Overpass");
  });
  it("finds a title despite a typo", () => {
    expect(understandQuery("neon overpas").seedTitles).toContain("Neon Overpass");
  });
  it("finds an artist reference", () => {
    expect(understandQuery("something by paper lanterns").filters.artist).toBe("Paper Lanterns");
  });
  it("does not mistake a generic word for an artist", () => {
    expect(understandQuery("midnight rooftop jazz").filters.artist).toBeUndefined();
  });
  it("finds a sounds-like reference", () => {
    const u = understandQuery("sounds like Tycho");
    expect(u.seedTitles.length).toBeGreaterThan(0);
  });
  it("records a reasoning trace", () => {
    expect(understandQuery("sad acoustic guitar").reasoning.length).toBeGreaterThan(0);
  });
  it("handles an empty query without throwing", () => {
    const u = understandQuery("");
    expect(u.tokens).toEqual([]);
    expect(u.filters).toEqual({});
  });
  it("handles a very long query", () => {
    const long = `${"calm lo-fi ".repeat(200)}`;
    const u = understandQuery(long);
    expect(u.filters.genres).toContain("lo-fi");
  });
  it("handles emoji and punctuation noise", () => {
    const u = understandQuery("🎧 lo-fi!!! (study) ???");
    expect(u.filters.genres).toContain("lo-fi");
  });
});

describe("filters", () => {
  const lofi = TRACKS.find((t) => t.id === "trk_koi_pond_morning")!;
  it("accepts a matching genre", () => {
    expect(matchesFilters(lofi, { genres: ["lo-fi"] }).ok).toBe(true);
  });
  it("rejects a non-matching genre", () => {
    expect(matchesFilters(lofi, { genres: ["rock"] }).ok).toBe(false);
  });
  it("checks instrumental", () => {
    expect(matchesFilters(lofi, { instrumental: true }).ok).toBe(true);
    expect(matchesFilters(lofi, { instrumental: false }).ok).toBe(false);
  });
  it("checks decade", () => {
    expect(matchesFilters(lofi, { decade: 2020 }).ok).toBe(true);
    expect(matchesFilters(lofi, { decade: 1990 }).ok).toBe(false);
  });
  it("checks bpm bounds", () => {
    expect(matchesFilters(lofi, { minBpm: 60, maxBpm: 90 }).ok).toBe(true);
    expect(matchesFilters(lofi, { minBpm: 200 }).ok).toBe(false);
  });
  it("checks artist", () => {
    expect(matchesFilters(lofi, { artist: "Koi System" }).ok).toBe(true);
    expect(matchesFilters(lofi, { artist: "Nobody" }).ok).toBe(false);
  });
  it("counts matches when no filter is given", () => {
    const r = matchesFilters(lofi, {});
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
  });
});

describe("search behaviour", () => {
  it("returns results for an empty query", () => {
    expect(search("").hits.length).toBeGreaterThan(0);
  });
  it("respects the limit", () => {
    expect(search("calm", { limit: 3 }).hits).toHaveLength(3);
  });
  it("returns an answer sentence", () => {
    expect(search("calm lo-fi").answer.length).toBeGreaterThan(20);
  });
  it("does not crash on nonsense", () => {
    const result = search("asdfghjkl qwertyuiop");
    expect(Array.isArray(result.hits)).toBe(true);
  });
  it("keeps scores inside [0, 1.2]", () => {
    for (const hit of search("night drive synth", { limit: 20 }).hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1.2);
    }
  });
  it("is sorted by score within each tier", () => {
    const hits = search("warm jazz piano", { limit: 20 }).hits;
    const strict = hits.filter((h) => !h.relaxed);
    const filled = hits.filter((h) => h.relaxed);
    for (let i = 1; i < strict.length; i++) expect(strict[i - 1].score).toBeGreaterThanOrEqual(strict[i].score);
    for (let i = 1; i < filled.length; i++) expect(filled[i - 1].score).toBeGreaterThanOrEqual(filled[i].score);
    // strict matches always come first
    if (filled.length && strict.length) {
      const firstFilled = hits.findIndex((h) => h.relaxed);
      const lastStrict = hits.reduce((last, hit, index) => (hit.relaxed ? last : index), -1);
      expect(firstFilled).toBeGreaterThan(lastStrict);
    }
  });

  it("marks filler results as relaxed", () => {
    const hits = search("calm lo-fi", { limit: 10 }).hits;
    expect(hits.length).toBe(10);
    expect(hits.some((h) => h.relaxed)).toBe(true);
  });

  it("returns the requested number of results when the catalog allows", () => {
    for (const limit of [1, 3, 5, 8, 12, 20]) {
      expect(search("calm", { limit }).hits.length).toBe(limit);
    }
  });
  it("explains every hit", () => {
    for (const hit of search("rainy acoustic folk", { limit: 10 }).hits) expect(hit.reasons.length).toBeGreaterThan(0);
  });
  it("returns a signal breakdown", () => {
    const hit = search("chill", { limit: 1 }).hits[0];
    expect(Object.keys(hit.signals).sort()).toEqual(["lexical", "metadata", "popularity", "reference", "semantic"]);
  });
  it("tracks latency in the response", () => {
    const result = search("focus");
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
    expect(result.tookMs).toBeLessThan(400);
  });

  // Every catalog track must be findable by its own title.
  for (const track of TRACKS) {
    it(`finds “${track.title}” by exact title`, () => {
      const result = search(track.title, { limit: 5 });
      expect(result.hits[0]?.track.id).toBe(track.id);
    });
  }

  for (const track of TRACKS) {
    it(`finds “${track.title}” by artist`, () => {
      const result = search(track.artist, { limit: 12 });
      expect(titles(result.hits)).toContain(track.title);
    });
  }

  // Typo tolerance for every title.
  for (const track of TRACKS) {
    it(`finds “${track.title}” with a typo`, () => {
      const typo = track.title.slice(0, -1) + "x";
      const result = search(typo, { limit: 5 });
      expect(titles(result.hits)).toContain(track.title);
    });
  }

  // Uppercase / mixed case must not matter.
  for (const track of TRACKS) {
    it(`finds “${track.title}” regardless of case`, () => {
      expect(search(track.title.toUpperCase(), { limit: 5 }).hits[0]?.track.id).toBe(track.id);
    });
  }

  // Genre queries should return genre-consistent results.
  for (const genre of ["lo-fi", "ambient", "synthwave", "house", "jazz", "acoustic", "pop", "rock", "classical", "hip-hop"]) {
    it(`genre query “${genre}” surfaces that genre first`, () => {
      const result = search(genre, { limit: 5 });
      expect(result.hits[0]?.track.genres).toContain(genre);
    });
  }

  for (const mood of ["calm", "energetic", "melancholic", "romantic", "dark"]) {
    it(`mood query “${mood}” surfaces that mood first`, () => {
      const result = search(mood, { limit: 5 });
      expect(result.hits[0]?.track.moods).toContain(mood);
    });
  }

  for (const track of TRACKS) {
    it(`“more like ${track.title}” returns related tracks`, () => {
      const result = search(`sounds like ${track.soundsLike[0]}`, { limit: 6 });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.some((h) => h.track.id === track.id)).toBe(true);
    });
  }

  for (const track of TRACKS) {
    it(`similarTracks(${track.id}) never returns itself`, () => {
      const similar = similarTracks(track.id, 6);
      expect(similar).toHaveLength(6);
      expect(similar.every((s) => s.track.id !== track.id)).toBe(true);
    });
    it(`similarTracks(${track.id}) prefers its own artist or genre`, () => {
      const similar = similarTracks(track.id, 3);
      const affinity = similar.filter(
        (s) => s.track.artistId === track.artistId || s.track.genres.some((g) => track.genres.includes(g)),
      );
      expect(affinity.length).toBeGreaterThan(0);
    });
  }
});

describe("natural language end-to-end", () => {
  const scenarios: { query: string; check: (r: ReturnType<typeof search>) => void }[] = [
    {
      query: "music to help me focus while coding",
      check: (r) => expect(["trk_study_loop_7", "trk_koi_pond_morning", "trk_broken_clock_band"]).toContain(r.hits[0].track.id),
    },
    {
      query: "something warm for a rainy drive, nothing with vocals, not too fast",
      check: (r) => {
        expect(r.understanding.filters.instrumental).toBe(true);
        expect(r.hits.every((h) => h.track.instrumental)).toBe(true);
        expect(r.hits.every((h) => h.track.bpm <= 108)).toBe(true);
      },
    },
    {
      query: "happy summer pop with vocals",
      check: (r) => expect(r.hits[0].track.moods).toContain("uplifting"),
    },
    {
      query: "dark techno for a warehouse at 2am",
      check: (r) => expect(r.hits.length).toBeGreaterThan(0),
    },
    {
      query: "jazz piano from the 2010s",
      check: (r) => {
        expect(r.hits.length).toBeGreaterThan(0);
        expect(r.hits.some((h) => h.track.genres.includes("jazz"))).toBe(true);
      },
    },
    {
      query: "lullaby for a baby",
      check: (r) => expect(r.hits.some((h) => h.track.moods.includes("calm"))).toBe(true),
    },
    {
      query: "workout bangers",
      check: (r) => expect(r.hits[0].track.energy).toBeGreaterThan(0.5),
    },
    {
      query: "sad music for a breakup",
      check: (r) => expect(r.hits[0].track.valence).toBeLessThan(0.6),
    },
    {
      query: "music for the gym, no vocals",
      check: (r) => expect(r.understanding.filters.instrumental).toBe(true),
    },
    {
      query: "80s retro synthwave night drive",
      check: (r) => expect(r.hits[0].track.genres.includes("synthwave") || r.hits[0].track.genres.includes("electronic")).toBe(true),
    },
  ];

  for (const scenario of scenarios) {
    it(`“${scenario.query}” behaves sensibly`, () => {
      const result = search(scenario.query, { limit: 8 });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.answer.length).toBeGreaterThan(10);
      scenario.check(result);
    });
  }

  it("relaxes filters instead of returning nothing", () => {
    const result = search("polka from 1930 with vocals and 300 bpm");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("answers with the top track title", () => {
    const result = search("neon overpass");
    expect(result.answer).toContain(result.hits[0].track.title);
  });

  it("explains when nothing matches", () => {
    const answer = buildAnswer(understandQuery("zzzz"), []);
    expect(answer).toMatch(/couldn't find/i);
  });

  it("groups hits by genre", () => {
    const groups = groupByGenre(search("electronic", { limit: 10 }).hits);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.reduce((n, g) => n + g.tracks.length, 0)).toBe(search("electronic", { limit: 10 }).hits.length);
  });

  it("rankTracks is deterministic for the same query", () => {
    const u = understandQuery("calm rainy jazz");
    const vec = embedText(u.raw);
    const a = rankTracks(u.tokens, vec, u, { limit: 8 });
    const b = rankTracks(u.tokens, vec, u, { limit: 8 });
    expect(titles(a.hits)).toEqual(titles(b.hits));
  });

  it("personalises with a taste profile", () => {
    const personalised = search("instrumental", { limit: 5, tasteProfile: { genres: ["ambient"], moods: ["calm"] } });
    expect(personalised.hits.length).toBeGreaterThan(0);
  });
});
