/**
 * In-memory inverted index + BM25 + embedding store for the SongHub catalog.
 *
 * Built once per process, synchronously (24 tracks => sub-millisecond), and
 * shared by the search API, the AI studio and the recommendation engine.
 */

import type { Track } from "../types";
import { TRACKS } from "../catalog/tracks";
import { tokenize, stem, trigrams, diceCoefficient, fuzzyScore, normaliseToken, FILLER_WORDS } from "./text";
import { embedTrack, cosine, type Vector, EMBED_DIM } from "./embed";
import { sharedState } from "../util";

export interface IndexedDoc {
  track: Track;
  /** term -> weighted tf */
  terms: Map<string, number>;
  length: number;
  vector: Vector;
  /** All searchable surface tokens (unweighted) for fuzzy rescue. */
  vocab: Set<string>;
}

export interface SearchIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLength: number;
  n: number;
  buildMs: number;
}

const FIELD_WEIGHTS = {
  title: 4,
  artist: 3,
  album: 1.2,
  tags: 1.8,
  genres: 2.2,
  moods: 2.0,
  description: 1.0,
  soundsLike: 1.6,
};

function addTerms(map: Map<string, number>, text: string, weight: number) {
  for (const token of tokenize(text)) {
    if (FILLER_WORDS.has(token)) continue;
    map.set(token, (map.get(token) ?? 0) + weight);
  }
}

export function buildDoc(track: Track): IndexedDoc {
  const terms = new Map<string, number>();
  addTerms(terms, track.title, FIELD_WEIGHTS.title);
  addTerms(terms, track.artist, FIELD_WEIGHTS.artist);
  addTerms(terms, track.album, FIELD_WEIGHTS.album);
  addTerms(terms, track.tags.join(" "), FIELD_WEIGHTS.tags);
  addTerms(terms, track.genres.join(" "), FIELD_WEIGHTS.genres);
  addTerms(terms, track.moods.join(" "), FIELD_WEIGHTS.moods);
  addTerms(terms, track.description, FIELD_WEIGHTS.description);
  addTerms(terms, track.soundsLike.join(" "), FIELD_WEIGHTS.soundsLike);

  // metadata tokens so structured queries ("2023", "112 bpm") resolve lexically too
  terms.set(`year:${track.year}`, 1.5);
  terms.set(`genre:${track.genres.join(",")}`, 1.5);
  terms.set(track.instrumental ? "vocal:instrumental" : "vocal:vocals", 1.2);
  for (const key of terms.keys()) terms.set(key, terms.get(key)!);

  let length = 0;
  for (const v of terms.values()) length += v;

  const vocab = new Set<string>();
  for (const t of tokenize(
    [track.title, track.artist, track.album, track.tags.join(" "), track.genres.join(" "), track.moods.join(" "), track.description, track.soundsLike.join(" ")].join(" "),
  )) {
    vocab.add(t);
  }

  return { track, terms, length, vector: embedTrack(track), vocab };
}

export function buildIndex(tracks: Track[] = TRACKS): SearchIndex {
  const started = performance.now();
  const docs = tracks.map(buildDoc);
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);
  return { docs, df, avgLength, n: docs.length, buildMs: performance.now() - started };
}

const cache = sharedState<{ index: SearchIndex | null }>("search-index", () => ({ index: null }));

export function getIndex(): SearchIndex {
  if (!cache.index) cache.index = buildIndex();
  return cache.index;
}

/** Reset the memoised index (used by tests). */
export function resetIndex(): void {
  cache.index = null;
}

const K1 = 1.25;
const B = 0.72;

function idf(index: SearchIndex, term: string): number {
  const df = index.df.get(term) ?? 0;
  return Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
}

/** BM25 score for a single (already normalised) term against one doc. */
export function bm25Term(index: SearchIndex, doc: IndexedDoc, term: string): number {
  const tf = doc.terms.get(term);
  if (!tf) return 0;
  const norm = 1 - B + (B * doc.length) / (index.avgLength || 1);
  return idf(index, term) * ((tf * (K1 + 1)) / (tf + K1 * norm));
}

export interface LexicalResult {
  score: number;
  matchedTerms: string[];
  fuzzyTerms: { query: string; matched: string; score: number }[];
}

/**
 * Score one document against a query.
 * Terms that miss the inverted index are retried against the document's own
 * vocabulary with a Dice/trigram comparison, which is what makes typos like
 * "synthwav" or "lofi beats" still work.
 */
export function lexicalScore(index: SearchIndex, doc: IndexedDoc, queryTerms: string[]): LexicalResult {
  let score = 0;
  const matchedTerms: string[] = [];
  const fuzzyTerms: { query: string; matched: string; score: number }[] = [];

  for (const raw of queryTerms) {
    const term = stem(normaliseToken(raw));
    if (!term) continue;
    const direct = bm25Term(index, doc, term);
    if (direct > 0) {
      score += direct;
      matchedTerms.push(term);
      continue;
    }
    // fuzzy rescue against this document's vocabulary
    let best = { matched: "", score: 0 };
    for (const candidate of doc.vocab) {
      if (Math.abs(candidate.length - term.length) > 3) continue;
      if (trigrams(candidate)[0] !== trigrams(term)[0] && candidate[0] !== term[0]) continue;
      // edit distance catches substitutions ("ovaspass"), trigram overlap catches
      // transpositions and truncations — take whichever is kinder
      const sim = Math.max(fuzzyScore(term, candidate) * 0.95, diceCoefficient(term, candidate));
      if (sim > best.score) best = { matched: candidate, score: sim };
    }
    if (best.score >= 0.7) {
      score += bm25Term(index, doc, best.matched) * best.score;
      matchedTerms.push(best.matched);
      fuzzyTerms.push({ query: term, matched: best.matched, score: best.score });
    }
  }

  return { score, matchedTerms, fuzzyTerms };
}

/** Cosine similarity of a query embedding against one doc. */
export function semanticScore(doc: IndexedDoc, queryVector: Vector): number {
  return cosine(doc.vector, queryVector);
}

/** Docs whose embedding is closest to a seed track (used for radio + "sounds like"). */
export function similarDocs(index: SearchIndex, seedId: string, limit = 10): { doc: IndexedDoc; score: number }[] {
  const seed = index.docs.find((d) => d.track.id === seedId);
  if (!seed) return [];
  return index.docs
    .filter((d) => d.track.id !== seedId)
    .map((d) => ({ doc: d, score: cosine(seed.vector, d.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export { EMBED_DIM };
