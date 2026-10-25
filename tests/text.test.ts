import { describe, expect, it } from "vitest";
import {
  STOPWORDS,
  SYNONYMS,
  diceCoefficient,
  fuzzyScore,
  levenshtein,
  normaliseToken,
  stem,
  stripInstructions,
  tokenize,
  trigrams,
} from "@/lib/ai/text";

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });
  it("removes punctuation", () => {
    expect(tokenize("lo-fi, beats! (chill)")).toEqual(["lo-fi", "beat", "chill"]);
  });
  it("drops stopwords by default", () => {
    expect(tokenize("the best of the best")).toEqual(["best", "best"]);
  });
  it("keeps stopwords when asked", () => {
    expect(tokenize("the best of the best", { keepStopwords: true })).toContain("the");
  });
  it("returns empty for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
  it("returns empty for whitespace", () => {
    expect(tokenize("    ")).toEqual([]);
  });
  it("handles apostrophes", () => {
    expect(tokenize("don't stop")).toEqual(["dont", "stop"]);
  });
  it("stems plural nouns", () => {
    expect(tokenize("drums")).toEqual(["drum"]);
  });
  it("keeps hyphenated words intact", () => {
    expect(tokenize("lo-fi")).toEqual(["lo-fi"]);
  });
  it("handles unicode accents gracefully", () => {
    // accents are folded to their base letter instead of dropped
    expect(tokenize("Ólafur Arnalds")).toEqual(["olafur", "arnald"]);
  });
  it("handles numbers", () => {
    expect(tokenize("80s synth 128 bpm")).toEqual(["80s", "synth", "128", "bpm"]);
  });
  it("is idempotent for already-normalised text", () => {
    const once = tokenize("Rainy Sunday Study Beats");
    const twice = tokenize(once.join(" "));
    expect(twice).toEqual(once);
  });
});

describe("stem", () => {
  const cases: [string, string][] = [
    ["studying", "study"],
    ["studied", "study"],
    ["studies", "study"],
    ["dancing", "dance"],
    ["running", "run"],
    ["beats", "beat"],
    ["relaxing", "relax"],
    ["tracks", "track"],
    ["glass", "glass"],
    ["jazz", "jazz"],
    ["rain", "rain"],
    ["drums", "drum"],
    ["mixes", "mix"],
    ["sleeping", "sleep"],
  ];
  for (const [input, expected] of cases) {
    it(`stems ${input} -> ${expected}`, () => {
      expect(stem(input)).toBe(expected);
    });
  }
  it("never returns an empty string for non-empty input", () => {
    for (const word of ["a", "ab", "abc", "x", "zzzz"]) expect(stem(word).length).toBeGreaterThan(0);
  });
  it("terminates (does not grow) for long words", () => {
    const long = "a".repeat(40);
    expect(stem(long).length).toBeLessThanOrEqual(long.length);
  });
});

describe("levenshtein", () => {
  it("is zero for identical strings", () => {
    expect(levenshtein("neon", "neon")).toBe(0);
  });
  it("counts substitution", () => {
    expect(levenshtein("neon", "nean")).toBe(1);
  });
  it("counts insertion", () => {
    expect(levenshtein("neon", "neons")).toBe(1);
  });
  it("counts deletion", () => {
    expect(levenshtein("neons", "neon")).toBe(1);
  });
  it("handles empty a", () => {
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("handles empty b", () => {
    expect(levenshtein("abc", "")).toBe(3);
  });
  it("handles completely different words", () => {
    expect(levenshtein("cat", "dog")).toBe(3);
  });
  it("is symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(levenshtein("sitting", "kitten"));
  });
  it("matches the classic kitten/sitting example", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("fuzzyScore", () => {
  it("returns 1 for identical input", () => {
    expect(fuzzyScore("abc", "abc")).toBe(1);
  });
  it("returns ~0.8 for one typo in five characters", () => {
    expect(fuzzyScore("neon!", "neonx")).toBeCloseTo(0.8, 5);
  });
  it("returns 1 for two empty strings", () => {
    expect(fuzzyScore("", "")).toBe(1);
  });
  it("stays within [0,1] for random pairs", () => {
    const words = ["neon", "overpass", "aurora", "drive", "rain", "tram", "koi", ""];
    for (const a of words) for (const b of words) {
      const score = fuzzyScore(a, b);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
  it("rates a typo above an unrelated word", () => {
    expect(fuzzyScore("synthwav", "synthwave")).toBeGreaterThan(fuzzyScore("synthwav", "acoustic"));
  });
});

describe("trigrams", () => {
  it("pads with boundary markers", () => {
    expect(trigrams("ab")).toEqual(["^ab", "ab$"]);
  });
  it("produces padded-length-minus-2 grams", () => {
    expect(trigrams("neon")).toHaveLength(4);
    expect(trigrams("a")).toHaveLength(1);
  });
  it("is stable for repeated calls", () => {
    expect(trigrams("aurora")).toEqual(trigrams("aurora"));
  });
});

describe("diceCoefficient", () => {
  it("is 1 for identical strings", () => {
    expect(diceCoefficient("overpass", "overpass")).toBeCloseTo(1, 6);
  });
  it("is high for a single typo", () => {
    expect(diceCoefficient("overpass", "overpas")).toBeGreaterThan(0.7);
  });
  it("is low for unrelated words", () => {
    expect(diceCoefficient("aurora", "jazz")).toBeLessThan(0.2);
  });
  it("is symmetric", () => {
    expect(diceCoefficient("neon", "harbor")).toBeCloseTo(diceCoefficient("harbor", "neon"), 10);
  });
});

describe("normaliseToken", () => {
  it("strips punctuation", () => {
    expect(normaliseToken("Hello!")).toBe("hello");
  });
  it("keeps hyphens", () => {
    expect(normaliseToken("lo-fi")).toBe("lo-fi");
  });
  it("removes apostrophes", () => {
    expect(normaliseToken("don't")).toBe("dont");
  });
  it("preserves digits", () => {
    expect(normaliseToken("1999")).toBe("1999");
  });
});

describe("stripInstructions", () => {
  it("removes 'play'", () => {
    expect(stripInstructions("play something calm")).toBe("calm");
  });
  it("removes 'find me some'", () => {
    expect(stripInstructions("find me some jazz")).toBe("jazz");
  });
  it("removes 'recommend'", () => {
    expect(stripInstructions("recommend a chill track")).toBe("chill track");
  });
  it("leaves plain descriptions untouched apart from filler", () => {
    expect(stripInstructions("neon overpass")).toBe("neon overpass");
  });
});

describe("lexicon", () => {
  it("has a focus concept", () => {
    expect(SYNONYMS.focus).toContain("study");
  });
  it("has more than 25 concepts", () => {
    expect(Object.keys(SYNONYMS).length).toBeGreaterThan(25);
  });
  it("every concept has at least three surface forms", () => {
    for (const [concept, forms] of Object.entries(SYNONYMS)) {
      expect(forms.length, concept).toBeGreaterThanOrEqual(3);
    }
  });
  it("stopwords include basic English function words", () => {
    for (const word of ["the", "and", "of", "to", "a"]) expect(STOPWORDS.has(word)).toBe(true);
  });
  it("stopwords do not contain music vocabulary", () => {
    for (const word of ["lo-fi", "jazz", "calm", "drums"]) expect(STOPWORDS.has(word)).toBe(false);
  });
});
