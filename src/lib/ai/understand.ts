/**
 * Query understanding — the "LLM-shaped" front half of the search pipeline.
 *
 * Turns free-form language ("something warm for a rainy drive home, nothing
 * with vocals, not too fast") into a structured request:
 * filters, soft targets, positive/negative concept weights, and actions
 * (play / shuffle / queue / make a playlist).
 *
 * It is rule + lexicon driven rather than a remote model call: deterministic,
 * explainable, offline, and it returns a `reasoning` trace that the UI shows.
 */

import type { QueryUnderstanding, SearchFilters, Track, Genre, Mood } from "../types";
import { tokenize, stem, normaliseToken, fuzzyScore, stripInstructions } from "./text";
import { conceptsFor } from "./embed";
import { TRACKS } from "../catalog/tracks";
import { clamp } from "../util";

const GENRES: Genre[] = ["lo-fi", "ambient", "synthwave", "indie", "jazz", "electronic", "acoustic", "hip-hop", "classical", "pop", "rock", "house"];
const MOODS: Mood[] = ["calm", "focused", "energetic", "melancholic", "uplifting", "dreamy", "dark", "romantic", "nostalgic", "triumphant"];

/** Mood -> where it sits in energy/valence space. */
const MOOD_VECTORS: Record<Mood, { energy: number; valence: number }> = {
  calm: { energy: 0.2, valence: 0.55 },
  focused: { energy: 0.4, valence: 0.5 },
  energetic: { energy: 0.9, valence: 0.7 },
  melancholic: { energy: 0.3, valence: 0.25 },
  uplifting: { energy: 0.75, valence: 0.85 },
  dreamy: { energy: 0.35, valence: 0.65 },
  dark: { energy: 0.5, valence: 0.15 },
  romantic: { energy: 0.45, valence: 0.75 },
  nostalgic: { energy: 0.55, valence: 0.6 },
  triumphant: { energy: 0.85, valence: 0.8 },
};

/** Concept (from the lexicon) -> canonical genre / mood it implies. */
const CONCEPT_TO_GENRES: Record<string, Genre[]> = {
  lofi: ["lo-fi", "hip-hop"],
  jazz: ["jazz"],
  classical: ["classical", "ambient"],
  house: ["house", "electronic"],
  synthwave: ["synthwave", "electronic"],
  ambient: ["ambient"],
  folk: ["acoustic", "indie"],
  rock: ["rock"],
  pop: ["pop"],
  hiphop: ["hip-hop"],
  electronic: ["electronic"],
};

const CONCEPT_TO_MOODS: Record<string, Mood[]> = {
  chill: ["calm"],
  focus: ["focused"],
  sleep: ["calm", "dreamy"],
  energetic: ["energetic"],
  sad: ["melancholic"],
  happy: ["uplifting"],
  romantic: ["romantic"],
  dark: ["dark"],
  nostalgic: ["nostalgic"],
  rain: ["melancholic", "calm"],
  summer: ["uplifting"],
  winter: ["calm", "dreamy"],
  gym: ["energetic"],
  drive: ["nostalgic", "energetic"],
  cinematic: ["triumphant", "dark"],
  morning: ["uplifting", "dreamy"],
  evening: ["romantic", "nostalgic"],
};

const NEGATIONS = ["no", "not", "without", "dont", "don't", "avoid", "except", "minus", "nothing"];

const BPM_WORDS: Record<string, [number, number]> = {
  slow: [50, 88],
  "very slow": [40, 75],
  downtempo: [60, 95],
  midtempo: [85, 112],
  upbeat: [105, 130],
  fast: [115, 160],
  quick: [115, 160],
  party: [110, 140],
};

const VOCAL_WORDS = ["vocal", "vocals", "voice", "singing", "sung", "lyric", "lyrics", "singer"];

/** True when the word at `idx` is preceded (within 3 words) by a negation. */
function isNegatedAt(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 26), idx).trim().split(/\s+/).filter(Boolean);
  return before.slice(-3).some((w) => NEGATIONS.some((n) => w.replace(/[^a-z']/g, "").startsWith(n)));
}

/** Alternate spellings we should accept for an artist name. */
function artistNormAliases(name: string): string[] {
  const norm = name.toLowerCase();
  const noSpace = norm.replace(/\s+/g, "");
  return [noSpace, norm.replace(/\s+/g, "-")];
}

/** Best fuzzy score between `needle` and any same-length-ish window of `haystack`. */
function bestFuzzyWindow(haystack: string, needle: string): number {
  const words = haystack.split(/\s+/);
  const needWords = needle.split(/\s+/).length;
  let best = 0;
  for (let i = 0; i + needWords <= words.length; i++) {
    const candidate = words.slice(i, i + needWords).join(" ");
    best = Math.max(best, fuzzyScore(candidate, needle));
  }
  return best;
}

export interface UnderstandOptions {
  /** Extra context, e.g. recently played genres, to gently personalise. */
  tasteProfile?: { genres: string[]; moods: string[] };
}

export function understandQuery(rawQuery: string, options: UnderstandOptions = {}): QueryUnderstanding {
  const raw = (rawQuery ?? "").trim();
  const normalized = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const reasoning: string[] = [];

  const allTokens = tokenize(normalized, { keepStopwords: true });
  const contentTokens = tokenize(normalized);

  const filters: SearchFilters = {};
  const expanded = new Set<string>(contentTokens);

  // ---- instructions ------------------------------------------------------
  const instructions = {
    play: /\b(play|put on|start|spin|listen to)\b/.test(normalized),
    shuffle: /\b(shuffle|random|mix it up)\b/.test(normalized),
    queue: /\b(queue|add to queue|up next|play next)\b/.test(normalized),
    createPlaylist: /\b(playlist|make me a|build me a|create a|mixtape)\b/.test(normalized),
    limit: undefined as number | undefined,
  };
  const limitMatch = normalized.match(/\b(?:top|first|give me|show me)\s+(\d{1,2})\b/) ?? normalized.match(/\b(\d{1,2})\s+(?:songs?|tracks?)\b/);
  if (limitMatch) {
    instructions.limit = clamp(parseInt(limitMatch[1], 10), 1, 30);
    reasoning.push(`Limit recognised: ${instructions.limit} tracks.`);
  }
  if (instructions.play) reasoning.push("Play intent detected — results will be queueable.");
  if (instructions.createPlaylist) reasoning.push("Playlist-building intent detected.");

  // ---- genre detection ---------------------------------------------------
  const genres = new Set<string>();
  for (const genre of GENRES) {
    const parts = genre.split(/[\s-]/);
    if (normalized.includes(genre)) genres.add(genre);
    else if (parts.length > 1 && parts.every((p) => normalized.includes(p))) genres.add(genre);
    else if (normalized.includes(genre.replace("-", ""))) genres.add(genre);
  }
  for (const token of contentTokens) {
    for (const concept of conceptsFor(token)) {
      for (const g of CONCEPT_TO_GENRES[concept] ?? []) genres.add(g);
    }
  }

  // ---- mood detection ----------------------------------------------------
  const moods = new Set<string>();
  for (const mood of MOODS) {
    if (normalized.includes(mood)) moods.add(mood);
    // naive stemming: "melancholy"/"melancholic"
    else if (normalized.includes(mood.slice(0, 5))) moods.add(mood);
  }
  for (const token of contentTokens) {
    for (const concept of conceptsFor(token)) {
      for (const m of CONCEPT_TO_MOODS[concept] ?? []) moods.add(m);
    }
  }

  // ---- negation handling -------------------------------------------------
  const negated = new Set<string>();
  const tokensLower = normalized.replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
  const SKIP_AFTER_NEGATION = new Set(["a", "an", "the", "any", "too", "so", "much", "very", "with", "of", "and", "to", "be", "is", "it", "that", "this", "more", "track", "tracks", "song", "songs"]);
  tokensLower.forEach((token, i) => {
    const clean = token.replace(/[^a-z']/g, "");
    if (!NEGATIONS.some((n) => clean === n.replace(/'/g, "") || clean === n)) return;
    // look ahead past filler words to the first real content word
    for (let j = i + 1; j < Math.min(tokensLower.length, i + 5); j++) {
      const candidate = normaliseToken(tokensLower[j]);
      if (!candidate || SKIP_AFTER_NEGATION.has(candidate)) continue;
      negated.add(candidate);
      for (const c of conceptsFor(candidate)) negated.add(`concept:${c}`);
      break;
    }
  });
  if (negated.size) {
    reasoning.push(`Negation detected for: ${[...negated].filter((n) => !n.startsWith("concept:")).join(", ") || "concepts"}.`);
    // "no vocals" / "without vocals" -> instrumental only
    if ([...negated].some((n) => ["vocal", "vocals", "voice", "singing", "lyric", "lyrics"].includes(n))) {
      filters.instrumental = true;
      reasoning.push("Excluding vocals — restricting to instrumental tracks.");
    }
    for (const g of [...genres]) if (negated.has(g) || negated.has(g.replace("-", ""))) genres.delete(g);
    for (const m of [...moods]) if (negated.has(m)) moods.delete(m);
  }

  if (/\b(instrumental|no vocals|without vocals|vocal-free)\b/.test(normalized)) {
    filters.instrumental = true;
  }
  const vocalNegated = VOCAL_WORDS.some((w) => negated.has(w)) || /\b(no|without|not)\b[\w\s]{0,10}\b(vocals?|lyrics?|singing)\b/.test(normalized);
  if (vocalNegated) {
    filters.instrumental = true;
    reasoning.push('Vocal negation seen — instrumental only.');
  } else if (/\b(with vocals|has vocals|vocals|lyrics|singing|sung)\b/.test(normalized)) {
    filters.instrumental = false;
  }

  // ---- bpm --------------------------------------------------------------
  const bpmExplicit = normalized.match(/(\d{2,3})\s*bpm/);
  if (bpmExplicit) {
    const target = parseInt(bpmExplicit[1], 10);
    filters.minBpm = target - 12;
    filters.maxBpm = target + 12;
    reasoning.push(`Target tempo ≈ ${target} BPM.`);
  }
  for (const [word, range] of Object.entries(BPM_WORDS)) {
    const idx = normalized.indexOf(word);
    if (idx === -1) continue;
    if (isNegatedAt(normalized, idx)) {
      // "not too fast" -> no upper tempo band, but keep the track relaxed
      reasoning.push(`Tempo word "${word}" was negated — ignoring it.`);
      if (word === "fast" || word === "quick" || word === "party") {
        filters.maxBpm = Math.min(filters.maxBpm ?? Infinity, 108);
        reasoning.push("Capped tempo at 108 BPM to keep things unhurried.");
      }
      break;
    }
    filters.minBpm = Math.min(filters.minBpm ?? Infinity, range[0]);
    filters.maxBpm = Math.max(filters.maxBpm ?? -Infinity, range[1]);
    reasoning.push(`Tempo band from "${word}": ${range[0]}–${range[1]} BPM.`);
    break;
  }

  // ---- decade / year -----------------------------------------------------
  const decade = normalized.match(/\b(19|20)(\d0)s\b/);
  if (decade) {
    filters.decade = parseInt(`${decade[1]}${decade[2]}`, 10);
    reasoning.push(`Decade filter: ${filters.decade}s.`);
  } else {
    // "90s", "80s" — the shorthand people actually type
    const shortDecade = normalized.match(/\b([2-9]0)s\b/);
    if (shortDecade) {
      const tens = parseInt(shortDecade[1], 10);
      filters.decade = tens >= 20 && tens <= 29 ? 2000 + tens : 1900 + tens;
      reasoning.push(`Decade shorthand "${shortDecade[0]}" → ${filters.decade}s.`);
    }
  }
  const explicitYear = normalized.match(/\b(20\d{2})\b/);
  if (explicitYear && !decade) {
    const y = parseInt(explicitYear[1], 10);
    filters.decade = Math.floor(y / 10) * 10;
    reasoning.push(`Year mentioned: ${y}.`);
  }

  // ---- artist / title references ----------------------------------------
  const seedTitles: string[] = [];
  const artistMatches: string[] = [];
  for (const track of TRACKS) {
    const titleNorm = track.title.toLowerCase();
    const artistNorm = track.artist.toLowerCase();
    if (normalized.includes(titleNorm)) {
      seedTitles.push(track.title);
      reasoning.push(`Direct title reference: “${track.title}”.`);
      continue;
    }
    if (normalized.includes(artistNorm) || artistNormAliases(track.artist).some((a) => normalized.includes(a))) {
      if (!artistMatches.includes(track.artist)) reasoning.push(`Artist reference: ${track.artist}.`);
      artistMatches.push(track.artist);
      seedTitles.push(track.title);
      continue;
    }
    // typo-tolerant full-name match ("neon harbur")
    if (artistNorm.length >= 7) {
      const window = normalized.slice(0, Math.max(0, normalized.length));
      const best = bestFuzzyWindow(window, artistNorm);
      if (best > 0.85) {
        if (!artistMatches.includes(track.artist)) {
          reasoning.push(`Approximate artist reference: ${track.artist} (${Math.round(best * 100)}% similar).`);
        }
        artistMatches.push(track.artist);
        seedTitles.push(track.title);
        continue;
      }
    }
    // fuzzy title match ("neon overpas")
    if (titleNorm.length > 6 && normalized.length > 5) {
      const fuzz = fuzzyScore(titleNorm, stripInstructions(normalized));
      if (fuzz > 0.86) {
        seedTitles.push(track.title);
        reasoning.push(`Approximate title reference: “${track.title}” (${(fuzz * 100).toFixed(0)}% similar).`);
      }
    }
  }
  // "sounds like <reference artist>" -> seed from soundsLike lists
  const soundsLikeMatch = normalized.match(/(?:sounds like|similar to|like|in the style of)\s+([a-z0-9 &'.-]{2,40})/);
  if (soundsLikeMatch) {
    const ref = soundsLikeMatch[1].trim();
    const hit = TRACKS.find((t) => t.soundsLike.some((s) => s.toLowerCase().includes(ref) || ref.includes(s.toLowerCase())));
    if (hit) {
      seedTitles.push(hit.title);
      reasoning.push(`Reference act noted: "${ref}" — anchoring on “${hit.title}”.`);
    }
  }
  if (artistMatches.length) filters.artist = artistMatches[0];

  // ---- soft targets ------------------------------------------------------
  let energyTarget: number | undefined;
  let valenceTarget: number | undefined;
  for (const mood of moods) {
    const vec = MOOD_VECTORS[mood as Mood];
    if (!vec) continue;
    energyTarget = energyTarget === undefined ? vec.energy : (energyTarget + vec.energy) / 2;
    valenceTarget = valenceTarget === undefined ? vec.valence : (valenceTarget + vec.valence) / 2;
  }
  if (options.tasteProfile && energyTarget === undefined && options.tasteProfile.moods.length) {
    const vec = MOOD_VECTORS[options.tasteProfile.moods[0] as Mood];
    if (vec) {
      energyTarget = vec.energy;
      valenceTarget = vec.valence;
      reasoning.push(`No explicit mood — leaning on your recent taste profile (${options.tasteProfile.moods[0]}).`);
    }
  }

  // A concrete title/artist/"sounds like" reference is a stronger signal than
  // genre keywords that often double as ordinary words ("radio" -> pop,
  // "house" -> house). When we have an anchor, let similarity do the work.
  if (seedTitles.length > 0 && (genres.size || moods.size)) {
    reasoning.push("Anchoring on a named reference — genre/mood keywords are treated as context, not filters.");
    genres.clear();
    moods.clear();
  }

  if (genres.size) filters.genres = [...genres] as string[];
  if (moods.size) filters.moods = [...moods] as string[];

  for (const token of contentTokens) {
    for (const concept of conceptsFor(token)) {
      for (const form of [concept]) expanded.add(form);
    }
  }

  if (!contentTokens.length) reasoning.push("Empty or purely instructional query — returning a personalised default mix.");
  if (filters.genres?.length) reasoning.push(`Genres inferred: ${filters.genres.join(", ")}.`);
  if (filters.moods?.length) reasoning.push(`Moods inferred: ${filters.moods.join(", ")}.`);

  const negativeTokens = [...negated].filter((n) => !n.startsWith("concept:"));

  return {
    raw,
    normalized,
    tokens: contentTokens,
    expandedTokens: [...expanded],
    filters,
    seedTitles,
    instructions,
    energyTarget,
    valenceTarget,
    bpmTarget: filters.minBpm && filters.maxBpm ? (filters.minBpm + filters.maxBpm) / 2 : undefined,
    negativeTokens,
    reasoning,
  };
}

export function getNegativeSignals(u: QueryUnderstanding): string[] {
  return Array.isArray(u.negativeTokens) ? u.negativeTokens : [];
}

export const MOOD_VECTORS_EXPORT = MOOD_VECTORS;
export type { Track };
