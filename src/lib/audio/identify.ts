/**
 * "Listen and identify" — the Shazam half of SongHub.
 *
 *   • builds a fingerprint index over the whole catalog (background, cached)
 *   • accepts a short recording (any audio the browser could decode, already
 *     downsampled to mono PCM)
 *   • returns ranked candidates with confidence + the offset in the track
 */

import type { IdentifyCandidate, IdentifyResult, Track } from "../types";
import { TRACKS } from "../catalog/tracks";
import { ANALYSIS_RATE, estimatePitch, renderRange, trackSampleCount } from "./synth";
import {
  confidenceFromVotes,
  fingerprintSamples,
  matchHashes,
  type MatchIndex,
} from "./fingerprint";
import { resampleMono, decodeWav } from "./wav";
import { clamp, sharedState } from "../util";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ensureDir, readBinary, readJson, writeBinary, writeJson } from "../storage";
import { estimateTempo } from "./tempo";

interface IndexMeta {
  version: number;
  builtAt: string;
  trackIds: string[];
  durations: Record<string, number>;
  count: number;
}

const INDEX_VERSION = 4;
const INDEX_META_FILE = "cache/fingerprint-index.meta.json";
const INDEX_BIN_FILE = "cache/fingerprint-index.bin";

export interface IndexState {
  status: "idle" | "building" | "ready" | "error";
  progress: number;
  builtAt?: string;
  buildMs?: number;
  trackCount: number;
  totalHashes: number;
  error?: string;
}

interface SharedIndexState {
  index: MatchIndex | null;
  state: IndexState;
  pending: Promise<MatchIndex> | null;
}

const shared = sharedState<SharedIndexState>("fingerprint-index", () => ({
  index: null,
  state: { status: "idle", progress: 0, trackCount: 0, totalHashes: 0 },
  pending: null,
}));

function trackIndexMapping(tracks: Track[]): Map<string, number> {
  return new Map(tracks.map((t, i) => [t.id, i]));
}

async function loadFromDisk(trackIds: string[]): Promise<MatchIndex | null> {
  const meta = await readJson<IndexMeta | null>(INDEX_META_FILE, null);
  if (!meta || meta.version !== INDEX_VERSION) return null;
  if (meta.trackIds.length !== trackIds.length) return null;
  if (!meta.trackIds.every((id, i) => id === trackIds[i])) return null;

  const raw = await readBinary(path.join(DATA_DIR, INDEX_BIN_FILE));
  if (!raw || raw.byteLength < meta.count * 7) return null;

  const ids = meta.trackIds;
  const hashes = new Uint32Array(raw.buffer, raw.byteOffset, meta.count);
  const times = new Uint16Array(raw.buffer, raw.byteOffset + meta.count * 4, meta.count);
  const tracks = new Uint8Array(raw.buffer, raw.byteOffset + meta.count * 6, meta.count);

  const map = new Map<number, { trackId: string; time: number }[]>();
  for (let i = 0; i < meta.count; i++) {
    const hash = hashes[i];
    const entry = { trackId: ids[tracks[i]] ?? ids[0], time: times[i] };
    const bucket = map.get(hash);
    if (bucket) bucket.push(entry);
    else map.set(hash, [entry]);
  }

  return {
    map,
    trackDurations: new Map(Object.entries(meta.durations)),
    totalHashes: meta.count,
    trackCount: ids.length,
    builtAt: meta.builtAt,
    buildMs: 0,
  };
}

/** Flat binary layout: [hash u32][time u16][track u8] × count. */
async function saveToDisk(idx: MatchIndex, tracks: Track[]): Promise<void> {
  const ids = tracks.map((t) => t.id);
  const idToIdx = trackIndexMapping(tracks);

  let count = 0;
  for (const bucket of idx.map.values()) count += bucket.length;

  const buffer = Buffer.allocUnsafe(count * 7);
  const hashes = new Uint32Array(buffer.buffer, buffer.byteOffset, count);
  const times = new Uint16Array(buffer.buffer, buffer.byteOffset + count * 4, count);
  const trackBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + count * 6, count);

  let i = 0;
  for (const [hash, bucket] of idx.map) {
    for (const entry of bucket) {
      if (i >= count) break;
      hashes[i] = hash;
      times[i] = Math.min(entry.time, 65535);
      trackBytes[i] = idToIdx.get(entry.trackId) ?? 0;
      i++;
    }
  }

  await ensureDir(path.join(DATA_DIR, "cache"));
  await writeBinary(path.join(DATA_DIR, INDEX_BIN_FILE), buffer);
  const meta: IndexMeta = {
    version: INDEX_VERSION,
    builtAt: idx.builtAt,
    trackIds: ids,
    durations: Object.fromEntries(idx.trackDurations),
    count,
  };
  await writeJson(INDEX_META_FILE, meta);
}

/**
 * Build the fingerprint database. Renders every track through the synth at the
 * analysis rate (≈140× realtime), then hashes it.
 */
export async function buildFingerprintIndex(
  onProgress?: (progress: number) => void,
): Promise<MatchIndex> {
  const started = Date.now();
  const map = new Map<number, { trackId: string; time: number }[]>();
  const durations = new Map<string, number>();
  let totalHashes = 0;

  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    const samples = renderRange(track.spec, 0, trackSampleCount(track.spec, ANALYSIS_RATE), ANALYSIS_RATE);
    const fp = fingerprintSamples(samples, ANALYSIS_RATE);
    durations.set(track.id, fp.durationSec);
    for (const [hash, times] of fp.hashes) {
      const bucket = map.get(hash);
      if (bucket) {
        for (const t of times) bucket.push({ trackId: track.id, time: t });
      } else {
        map.set(
          hash,
          times.map((t) => ({ trackId: track.id, time: t })),
        );
      }
      totalHashes += times.length;
    }
    onProgress?.((i + 1) / TRACKS.length);
    // yield to the event loop so the dev server keeps responding
    await new Promise((r) => setImmediate(r));
  }

  const built: MatchIndex = {
    map,
    trackDurations: durations,
    totalHashes,
    trackCount: TRACKS.length,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - started,
  };

  await saveToDisk(built, TRACKS);
  return built;
}

/** Ensure the index exists; safe to call concurrently. */
export async function ensureFingerprintIndex(): Promise<MatchIndex> {
  if (shared.index) return shared.index;
  if (shared.pending) return shared.pending;

  shared.pending = (async () => {
    shared.state = { status: "building", progress: 0, trackCount: TRACKS.length, totalHashes: 0 };
    try {
      const trackIds = TRACKS.map((t) => t.id);
      const cached = await loadFromDisk(trackIds);
      if (cached) {
        shared.index = cached;
        shared.state = {
          status: "ready",
          progress: 1,
          builtAt: cached.builtAt,
          buildMs: cached.buildMs,
          trackCount: cached.trackCount,
          totalHashes: cached.totalHashes,
        };
        return cached;
      }
      const built = await buildFingerprintIndex((p) => {
        shared.state = { ...shared.state, progress: p };
      });
      shared.index = built;
      shared.state = {
        status: "ready",
        progress: 1,
        builtAt: built.builtAt,
        buildMs: built.buildMs,
        trackCount: built.trackCount,
        totalHashes: built.totalHashes,
      };
      return built;
    } catch (error) {
      shared.state = { ...shared.state, status: "error", error: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      shared.pending = null;
    }
  })();

  return shared.pending;
}

export function getIndexState(): IndexState {
  return shared.state;
}

/** Kick off the build without awaiting it (used by the health endpoint). */
export function warmFingerprintIndex(): void {
  if (shared.index || shared.pending) return;
  ensureFingerprintIndex().catch(() => undefined);
}

/** Test hook. */
export function resetFingerprintIndex(): void {
  shared.index = null;
  shared.pending = null;
  shared.state = { status: "idle", progress: 0, trackCount: 0, totalHashes: 0 };
}

/** Interpret a request body as PCM: raw little-endian int16, or a WAV container. */
export function decodeRequestBody(buffer: Buffer, sampleRateHeader: number): { samples: Float32Array; sampleRate: number } {
  const isWav = buffer.byteLength > 12 && buffer.toString("ascii", 0, 4) === "RIFF";
  if (isWav) {
    const { samples, sampleRate } = decodeWav(buffer);
    return { samples, sampleRate };
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = Math.floor(buffer.byteLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { samples, sampleRate: sampleRateHeader || ANALYSIS_RATE };
}

export const MAX_CLIP_SECONDS = 30;

export interface IdentifyOptions {
  /** Max number of candidates to return. */
  limit?: number;
  /** Reject clips that are silent/too short. */
  minSeconds?: number;
}

export async function identifyClip(
  samples: Float32Array,
  sampleRate: number,
  options: IdentifyOptions = {},
): Promise<IdentifyResult> {
  const started = Date.now();
  const minSeconds = options.minSeconds ?? 1.2;
  const limit = options.limit ?? 5;

  const mono = resampleMono(samples, sampleRate, ANALYSIS_RATE);
  const limited = mono.length > ANALYSIS_RATE * MAX_CLIP_SECONDS ? mono.subarray(0, ANALYSIS_RATE * MAX_CLIP_SECONDS) : mono;
  const durationSec = limited.length / ANALYSIS_RATE;

  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < limited.length; i++) {
    const a = Math.abs(limited[i]);
    if (a > peak) peak = a;
    sumSq += limited[i] * limited[i];
  }
  const rms = limited.length ? Math.sqrt(sumSq / limited.length) : 0;
  const tempoBpm = estimateTempo(limited, ANALYSIS_RATE);
  const dominantPitchHz = estimatePitch(limited, ANALYSIS_RATE);

  const input = {
    durationSec: Number(durationSec.toFixed(2)),
    sampleRate: ANALYSIS_RATE,
    peakAmplitude: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    tempoBpm: Number(tempoBpm.toFixed(1)),
    dominantPitchHz: Number(dominantPitchHz.toFixed(1)),
  };

  if (durationSec < minSeconds) {
    return {
      ok: false,
      input,
      candidates: [],
      best: null,
      confidence: 0,
      message: `That clip was only ${durationSec.toFixed(1)}s — I need at least ${minSeconds}s of audio to recognise anything.`,
      tookMs: Date.now() - started,
    };
  }
  if (rms < 0.0015) {
    return {
      ok: false,
      input,
      candidates: [],
      best: null,
      confidence: 0,
      message: "The clip is silent (or far too quiet). Try again closer to the speaker.",
      tookMs: Date.now() - started,
    };
  }

  const idx = await ensureFingerprintIndex();
  const fingerprint = fingerprintSamples(limited, ANALYSIS_RATE);
  const votes = matchHashes(fingerprint.hashes, idx);

  const candidates: IdentifyCandidate[] = [];
  for (const vote of votes.slice(0, Math.max(limit, 3) * 2)) {
    const track = TRACKS.find((t) => t.id === vote.trackId);
    if (!track) continue;
    const matchRate = vote.votes / Math.max(1, fingerprint.hashes.size);
    const score = clamp(vote.votes / 30 + matchRate * 0.4, 0, 1);
    candidates.push({
      track,
      score: Number(score.toFixed(3)),
      confidence: 0,
      matchedHashes: vote.votes,
      offsetSec: Number(((vote.offset * 400) / ANALYSIS_RATE).toFixed(2)),
    });
  }
  candidates.sort((a, b) => b.matchedHashes - a.matchedHashes || b.score - a.score);

  const { confidence: rawConfidence } = confidenceFromVotes(votes);
  // Scale by how much of the query actually matched — guards against noise clips
  // that happen to produce a few random hash collisions.
  const coverage = fingerprint.hashes.size ? votes[0]?.votes / fingerprint.hashes.size : 0;
  const confidence = clamp(rawConfidence * (0.45 + clamp(coverage * 6, 0, 1) * 0.55), 0, 1);

  for (const candidate of candidates) {
    candidate.confidence = candidate === candidates[0] ? Number(confidence.toFixed(3)) : Number((confidence * 0.45 * candidate.score).toFixed(3));
  }

  const accepted = confidence >= 0.42 && (candidates[0]?.matchedHashes ?? 0) >= 6;
  const best = accepted ? candidates[0] : null;

  const message = !candidates.length
    ? "Nothing in your library matched that clip. Try holding the mic closer, or search online instead."
    : accepted
      ? `That's “${candidates[0].track.title}” by ${candidates[0].track.artist}, starting around ${formatOffset(candidates[0].offsetSec)}.`
      : "That didn't match anything in your library confidently. You can search these web results instead.";

  return {
    ok: accepted,
    input,
    candidates: candidates.slice(0, limit),
    best,
    confidence: Number(confidence.toFixed(3)),
    message,
    tookMs: Date.now() - started,
  };
}

function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export { ANALYSIS_RATE };
