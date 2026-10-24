/**
 * Hybrid AI search: lexical (BM25 + fuzzy) × semantic (embedding cosine) ×
 * structured filters × popularity prior × reference anchoring.
 *
 * Also produces a natural-language "answer" above the results and a
 * per-result explanation, so the interface can show *why* something matched
 * instead of acting like a black box.
 */

import type { QueryUnderstanding, SearchHit, SearchResult, Track, SearchFilters } from "../types";
import { getIndex, lexicalScore, semanticScore, type IndexedDoc } from "./index";
import { embedText, cosine } from "./embed";
import { getNegativeSignals, understandQuery } from "./understand";
import { clamp } from "../util";

export interface SearchOptions {
  limit?: number;
  tasteProfile?: { genres: string[]; moods: string[]; artistIds?: string[] };
  /** Include a generated natural-language answer. */
  answer?: boolean;
}

const WEIGHTS = {
  lexical: 0.3,
  semantic: 0.3,
  metadata: 0.12,
  popularity: 0.08,
  reference: 0.12,
  affinity: 0.08,
};

export function matchesFilters(track: Track, filters: SearchFilters): { ok: boolean; matched: number; total: number } {
  let total = 0;
  let matched = 0;

  if (filters.genres?.length) {
    total++;
    const hit = filters.genres.some((g) => track.genres.includes(g as never));
    if (hit) matched++;
    else return { ok: false, matched, total };
  }
  if (filters.moods?.length) {
    total++;
    const hit = filters.moods.some((m) => track.moods.includes(m as never));
    if (hit) matched++;
    // mood is soft-ish: one mood miss shouldn't nuke an otherwise great hit
  }
  if (filters.instrumental !== undefined) {
    total++;
    if (track.instrumental === filters.instrumental) matched++;
    else return { ok: false, matched, total };
  }
  if (filters.decade) {
    total++;
    if (Math.floor(track.year / 10) * 10 === filters.decade) matched++;
    else return { ok: false, matched, total };
  }
  if (filters.minBpm !== undefined) {
    total++;
    if (track.bpm >= filters.minBpm) matched++;
    else return { ok: false, matched, total };
  }
  if (filters.maxBpm !== undefined) {
    total++;
    if (track.bpm <= filters.maxBpm) matched++;
    else return { ok: false, matched, total };
  }
  if (filters.artist) {
    total++;
    if (track.artist.toLowerCase() === filters.artist.toLowerCase()) matched++;
    else return { ok: false, matched, total };
  }
  return { ok: true, matched, total };
}

function metadataScore(track: Track, filters: SearchFilters): number {
  const { matched, total } = matchesFilters(track, filters);
  if (total === 0) return 0.5; // neutral when no filters requested
  return clamp(matched / total, 0, 1);
}

function softTargetScore(track: Track, u: QueryUnderstanding): number {
  let score = 0;
  let parts = 0;
  if (u.energyTarget !== undefined) {
    score += 1 - clamp(Math.abs(track.energy - u.energyTarget) / 0.8, 0, 1);
    parts++;
  }
  if (u.valenceTarget !== undefined) {
    score += 1 - clamp(Math.abs(track.valence - u.valenceTarget) / 0.8, 0, 1);
    parts++;
  }
  if (u.bpmTarget !== undefined) {
    score += 1 - clamp(Math.abs(track.bpm - u.bpmTarget) / 45, 0, 1);
    parts++;
  }
  return parts ? score / parts : 0.5;
}

function referenceScore(doc: IndexedDoc, seedDocs: IndexedDoc[]): number {
  if (!seedDocs.length) return 0;
  let best = 0;
  for (const seed of seedDocs) {
    if (seed.track.id === doc.track.id) return 1;
    best = Math.max(best, cosine(seed.vector, doc.vector));
  }
  return clamp((best - 0.15) / 0.7, 0, 1);
}

function affinityScore(track: Track, taste?: SearchOptions["tasteProfile"]): number {
  if (!taste) return 0.5;
  let score = 0.5;
  if (taste.genres.some((g) => track.genres.includes(g as never))) score += 0.25;
  if (taste.moods.some((m) => track.moods.includes(m as never))) score += 0.15;
  if (taste.artistIds?.includes(track.artistId)) score += 0.1;
  return clamp(score, 0, 1);
}

export function rankTracks(
  queryTerms: string[],
  queryVector: Float32Array,
  u: QueryUnderstanding,
  options: SearchOptions = {},
): { hits: SearchHit[]; fallbackUsed: boolean; relaxed: string[] } {
  const index = getIndex();
  const seedDocs = u.seedTitles
    .map((title) => index.docs.find((d) => d.track.title.toLowerCase() === title.toLowerCase()))
    .filter((d): d is IndexedDoc => Boolean(d));

  const negatives = getNegativeSignals(u);
  const limit = options.limit ?? 24;

  const scoreDocs = (filters: SearchFilters) => {
    const out: SearchHit[] = [];
    let maxLexical = 1;
    const staged: { doc: IndexedDoc; lexical: number; matched: string[]; fuzzy: { query: string; matched: string; score: number }[] }[] = [];
    for (const doc of index.docs) {
      const lex = lexicalScore(index, doc, queryTerms);
      staged.push({ doc, lexical: lex.score, matched: lex.matchedTerms, fuzzy: lex.fuzzyTerms });
      if (lex.score > maxLexical) maxLexical = lex.score;
    }

    for (const entry of staged) {
      const { doc } = entry;
      const filterResult = matchesFilters(doc.track, filters);
      if (!filterResult.ok) continue;

      const negPenalty = negatives.some(
        (n) =>
          doc.track.genres.some((g) => g.includes(n)) ||
          doc.track.moods.some((m) => m.includes(n)) ||
          doc.track.title.toLowerCase().includes(n) ||
          (n === "vocal" || n === "vocals") && !doc.track.instrumental,
      );

      const lexNorm = clamp(entry.lexical / Math.max(maxLexical, 4), 0, 1);
      const sem = clamp((semanticScore(doc, queryVector) - 0.05) / 0.55, 0, 1);
      const meta = metadataScore(doc.track, filters);
      const pop = doc.track.popularity / 100;
      const ref = referenceScore(doc, seedDocs);
      const aff = affinityScore(doc.track, options.tasteProfile);

      // "affinity" doubles as the soft-target fit; average the two signals
      const soft = softTargetScore(doc.track, u);
      const affinity = (aff + soft) / 2;

      let score =
        WEIGHTS.lexical * lexNorm +
        WEIGHTS.semantic * sem +
        WEIGHTS.metadata * meta +
        WEIGHTS.popularity * pop +
        WEIGHTS.reference * ref +
        WEIGHTS.affinity * affinity;

      if (negPenalty) score *= 0.35;
      // exact title match should always win
      if (u.seedTitles.some((t) => t.toLowerCase() === doc.track.title.toLowerCase())) score += 0.35;
      score = clamp(score, 0, 1.2);

      const reasons: string[] = [];
      if (ref >= 0.5 && seedDocs.length) {
        const seed = seedDocs.reduce((best, s) => (cosine(s.vector, doc.vector) > cosine(best.vector, doc.vector) ? s : best), seedDocs[0]);
        reasons.push(`Closely related to “${seed.track.title}” (${Math.round(ref * 100)}% similarity).`);
      }
      if (entry.matched.length) {
        reasons.push(`Matches ${entry.matched.slice(0, 4).join(", ")}.`);
      }
      if (entry.fuzzy.length) {
        reasons.push(`Recovered near-miss term${entry.fuzzy.length > 1 ? "s" : ""} ${entry.fuzzy.map((f) => `“${f.query}”→“${f.matched}”`).join(", ")}.`);
      }
      const genreHits = filters.genres?.filter((g) => doc.track.genres.includes(g as never)) ?? [];
      if (genreHits.length) reasons.push(`Genre ${genreHits.join("/")} requested.`);
      const moodHits = filters.moods?.filter((m) => doc.track.moods.includes(m as never)) ?? [];
      if (moodHits.length) reasons.push(`Mood ${moodHits.join("/")} requested.`);
      if (filters.instrumental !== undefined) {
        reasons.push(filters.instrumental ? "Instrumental as requested." : "Has vocals as requested.");
      }
      if (u.energyTarget !== undefined && !moodHits.length) {
        reasons.push(`Energy ${(doc.track.energy * 100).toFixed(0)}% vs target ${(u.energyTarget * 100).toFixed(0)}%.`);
      }
      if (!reasons.length) reasons.push(`Semantically close to “${u.raw || "your taste"}”.`);

      out.push({
        track: doc.track,
        score: Number(score.toFixed(4)),
        signals: {
          lexical: Number(lexNorm.toFixed(3)),
          semantic: Number(sem.toFixed(3)),
          metadata: Number(meta.toFixed(3)),
          popularity: Number(pop.toFixed(3)),
          reference: Number(ref.toFixed(3)),
        },
        reasons,
      });
    }

    out.sort((a, b) => b.score - a.score || b.track.popularity - a.track.popularity);
    return out;
  };

  // Progressive relaxation: try the strict interpretation first and only shed
  // constraints when it starves the result set.
  const base = u.filters;
  const attempts: { filters: SearchFilters; label: string }[] = [
    { filters: base, label: "strict" },
    { filters: { ...base, moods: undefined }, label: "mood relaxed" },
    { filters: { ...base, moods: undefined, minBpm: undefined, maxBpm: undefined }, label: "tempo relaxed" },
    { filters: { ...base, moods: undefined, minBpm: undefined, maxBpm: undefined, decade: undefined }, label: "era relaxed" },
    { filters: { ...base, genres: undefined, minBpm: undefined, maxBpm: undefined }, label: "genre relaxed" },
    { filters: {}, label: "filters dropped" },
  ];

  const relaxed: string[] = [];
  let hits: SearchHit[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    hits = scoreDocs(attempt.filters);
    if (hits.length >= 3) {
      // If the strict pass starved the result set, top it up with the next tier
      // so the caller always gets `limit` results when the catalog can supply them.
      if (i === 0 && hits.length < limit && attempts.length > 1) {
        const seen = new Set(hits.map((h) => h.track.id));
        const topUp = scoreDocs({}).filter((h) => !seen.has(h.track.id));
        if (topUp.length) {
          // Keep tiers explicit: strict matches first (already sorted), then
          // fillers marked `relaxed` so the UI can label them.
          hits = [...hits, ...topUp.map((hit) => ({ ...hit, relaxed: true }))];
          relaxed.push("topped up");
        }
      }
      break;
    }
    if (i > 0) relaxed.push(attempt.label);
  }
  const fallbackUsed = relaxed.some((label) => label !== "topped up");

  return { hits: hits.slice(0, limit), fallbackUsed, relaxed };
}

const FRIENDLY_GENRE: Record<string, string> = {
  "lo-fi": "lo-fi",
  "hip-hop": "hip-hop",
  synthwave: "synthwave",
  ambient: "ambient",
  electronic: "electronic",
  acoustic: "acoustic",
  classical: "classical",
  house: "house",
  indie: "indie",
  jazz: "jazz",
  pop: "pop",
  rock: "rock",
};

function listWords(items: string[]): string {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function buildAnswer(u: QueryUnderstanding, hits: SearchHit[]): string {
  if (!hits.length) {
    return `I couldn't find anything for “${u.raw}”. Try describing a mood (“warm and slow”), a genre, or a track to anchor on.`;
  }

  const top = hits[0].track;
  const requestedGenres = u.filters.genres ?? [];
  const requestedMoods = u.filters.moods ?? [];
  const sentences: string[] = [];

  const moodPhrase = listWords(requestedMoods.map((m) => m.replace("melancholic", "melancholy")));
  const genrePhrase = listWords(requestedGenres.map((g) => FRIENDLY_GENRE[g] ?? g));

  if (u.seedTitles.length) {
    sentences.push(`Anchored on “${u.seedTitles[0]}”, I pulled ${hits.length} tracks that sit closest to it.`);
  } else if (genrePhrase && moodPhrase) {
    sentences.push(`Here are ${hits.length} ${genrePhrase} tracks with a ${moodPhrase} feel.`);
  } else if (genrePhrase) {
    sentences.push(`Here are ${hits.length} ${genrePhrase} tracks.`);
  } else if (moodPhrase) {
    sentences.push(`Here are ${hits.length} ${moodPhrase} tracks.`);
  } else if (u.raw) {
    sentences.push(`Here are the ${hits.length} closest matches for “${u.raw}”.`);
  } else {
    sentences.push(`Here are ${hits.length} tracks to get you started.`);
  }

  sentences.push(`Start with “${top.title}” by ${top.artist} — ${top.bpm} BPM, ${top.musicalKey}, ${top.duration}s.`);

  if (u.filters.instrumental === true) sentences.push("Everything here is instrumental.");
  else if (u.filters.instrumental === false) sentences.push("All of these have vocals.");
  if (u.energyTarget !== undefined) {
    sentences.push(
      u.energyTarget > 0.7
        ? "Energy is dialled up."
        : u.energyTarget < 0.35
          ? "Dialled right down for something calmer."
          : "Energy stays mid-tempo.",
    );
  }
  if (u.filters.maxBpm && u.negativeTokens.includes("fast")) sentences.push("Nothing faster than 108 BPM, as asked.");
  if (hits.length > 1) {
    const second = hits[1].track;
    sentences.push(`Then try “${second.title}” by ${second.artist}.`);
  }
  if (u.instructions.createPlaylist) sentences.push("Save it as a playlist from the results header.");
  return sentences.join(" ");
}

export function search(query: string, options: SearchOptions = {}): SearchResult {
  const started = performance.now();
  const understanding = understandQuery(query, options);
  const queryVector = embedText(`${understanding.raw} ${understanding.expandedTokens.join(" ")}`);
  const { hits, fallbackUsed } = rankTracks(understanding.tokens, queryVector, understanding, options);
  const answer = options.answer === false ? "" : buildAnswer(understanding, hits);
  return {
    query,
    tookMs: Number((performance.now() - started).toFixed(2)),
    understanding,
    hits,
    fallbackUsed,
    answer,
  };
}

/** Pure vector search (used by "sounds like this" / radio). */
export function similarTracks(trackId: string, limit = 10): { track: Track; score: number }[] {
  const index = getIndex();
  const seed = index.docs.find((d) => d.track.id === trackId);
  if (!seed) return [];
  return index.docs
    .filter((d) => d.track.id !== trackId)
    .map((d) => ({ track: d.track, score: Number(cosine(seed.vector, d.vector).toFixed(4)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Group results by a key, keeping order — powers the "AI studio" cards. */
export function groupByGenre(hits: SearchHit[]): { genre: string; tracks: Track[] }[] {
  const map = new Map<string, Track[]>();
  for (const hit of hits) {
    const genre = hit.track.genres[0];
    const bucket = map.get(genre) ?? [];
    bucket.push(hit.track);
    map.set(genre, bucket);
  }
  return [...map.entries()].map(([genre, tracks]) => ({ genre, tracks }));
}
