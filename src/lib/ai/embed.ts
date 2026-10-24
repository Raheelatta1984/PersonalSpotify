/**
 * Deterministic, dependency-free semantic embeddings.
 *
 * Strategy — a "hashing trick" feature vector over many views of a document:
 *   • unigrams / bigrams of the text (stemmed)
 *   • character trigrams (typo + morphology tolerant)
 *   • explicit structured features (genre:, mood:, tag:, bpm band, decade)
 *   • concept-cluster expansions from the domain lexicon
 *
 * Features hash into a fixed-width vector with a sign trick (Weinberger et al.),
 * then the vector is L2-normalised so cosine similarity == dot product.
 *
 * This behaves like a small trained embedding for a closed domain: "help me
 * focus while coding" lands near "Study Loop 7" because both share the
 * `focus`/`minimal`/`electronic` concept dimensions, not because of a shared
 * literal token. It is fully reproducible, runs in ~µs, and needs no model files.
 */

import { trigrams, stem, tokenize, SYNONYMS, normaliseToken } from "./text";
import type { Track } from "../types";

export const EMBED_DIM = 512;

export type Vector = Float32Array;

function addFeature(vec: Vector, feature: string, weight: number) {
  // two independent hashes per feature reduce collision damage
  const seeds = [0x9e3779b1, 0x85ebca6b];
  for (const seed of seeds) {
    let h = seed >>> 0;
    for (let i = 0; i < feature.length; i++) {
      h ^= feature.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const idx = h % EMBED_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += (sign * weight) / 2;
  }
}

function addText(vec: Vector, text: string, weight: number) {
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    addFeature(vec, `u:${t}`, weight);
    // character trigrams let "concetrate" still reach "concentrate"
    for (const g of trigrams(t)) addFeature(vec, `c:${g}`, weight * 0.22);
    if (i + 1 < tokens.length) addFeature(vec, `b:${t}_${tokens[i + 1]}`, weight * 0.6);
  }
}

/** Expand a token into its canonical concept ids (if any). */
export function conceptsFor(token: string): string[] {
  const norm = normaliseToken(token);
  const direct = new Set<string>([... (SURFACE_TO_CONCEPTS_CACHE.get(norm) ?? [])]);
  const stemmed = stem(norm);
  for (const [surface, concepts] of SURFACE_TO_CONCEPTS_CACHE) {
    if (stem(surface) === stemmed) for (const c of concepts) direct.add(c);
  }
  return [...direct];
}

const SURFACE_TO_CONCEPTS_CACHE = (() => {
  const map = new Map<string, string[]>();
  for (const [concept, forms] of Object.entries(SYNONYMS)) {
    for (const raw of [concept, ...forms]) {
      const form = normaliseToken(raw);
      const bucket = map.get(form) ?? [];
      if (!bucket.includes(concept)) bucket.push(concept);
      map.set(form, bucket);
    }
  }
  return map;
})();

/** Concept ids implied by a piece of text (with counts). */
export function conceptProfile(text: string): Map<string, number> {
  const profile = new Map<string, number>();
  for (const token of tokenize(text, { keepStopwords: true })) {
    for (const concept of conceptsFor(token)) {
      profile.set(concept, (profile.get(concept) ?? 0) + 1);
    }
  }
  return profile;
}

function addConcepts(vec: Vector, text: string, weight: number) {
  for (const [concept, count] of conceptProfile(text)) {
    addFeature(vec, `k:${concept}`, weight * Math.min(3, 1 + 0.5 * (count - 1)));
    // expand the concept into its sibling surface forms for extra coverage
    for (const sibling of SYNONYMS[concept] ?? []) {
      const t = stem(normaliseToken(sibling));
      if (t) addFeature(vec, `u:${t}`, weight * 0.3);
    }
  }
}

function bpmBand(bpm: number): string {
  if (bpm < 70) return "very-slow";
  if (bpm < 90) return "slow";
  if (bpm < 110) return "midtempo";
  if (bpm < 125) return "upbeat";
  return "fast";
}

export function trackDocument(track: Track): string {
  return [
    track.title,
    track.artist,
    track.album,
    track.genres.join(" "),
    track.moods.join(" "),
    track.tags.join(" "),
    track.description,
    track.soundsLike.join(" "),
    track.instrumental ? "instrumental no vocals" : "vocals lyrics sung",
    `${track.year}`,
    `${track.bpm} bpm`,
    track.musicalKey,
  ]
    .filter(Boolean)
    .join(" \n ");
}

export function embedText(text: string): Vector {
  const vec = new Float32Array(EMBED_DIM);
  addText(vec, text, 1);
  addConcepts(vec, text, 0.85);
  return l2Normalise(vec);
}

export function embedTrack(track: Track): Vector {
  const vec = new Float32Array(EMBED_DIM);

  addText(vec, `${track.title} ${track.artist}`, 1.6);
  addText(vec, track.description, 1.0);
  addText(vec, track.soundsLike.join(" "), 1.5);
  addText(vec, track.tags.join(" "), 0.9);
  addText(vec, `${track.album} ${track.year} ${track.genres.join(" ")} ${track.moods.join(" ")}`, 0.8);
  addConcepts(vec, trackDocument(track), 0.9);

  for (const g of track.genres) addFeature(vec, `g:${g}`, 2.4);
  for (const m of track.moods) addFeature(vec, `m:${m}`, 2.0);
  for (const t of track.tags) addFeature(vec, `t:${normaliseToken(t)}`, 1.1);
  addFeature(vec, `artist:${normaliseToken(track.artist)}`, 3.0);
  addFeature(vec, `album:${normaliseToken(track.album)}`, 1.2);
  addFeature(vec, `bpm:${bpmBand(track.bpm)}`, 1.4);
  addFeature(vec, `decade:${Math.floor(track.year / 10) * 10}`, 1.0);
  addFeature(vec, `energy:${Math.round(track.energy * 4)}`, 1.2);
  addFeature(vec, `valence:${Math.round(track.valence * 4)}`, 1.2);
  addFeature(vec, track.instrumental ? "vocal:instrumental" : "vocal:yes", 1.6);

  return l2Normalise(vec);
}

export function l2Normalise(vec: Vector): Vector {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function cosineDistance(a: Vector, b: Vector): number {
  return 1 - cosine(a, b);
}
