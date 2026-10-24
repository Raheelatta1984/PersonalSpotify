/**
 * Byte-range WAV streaming straight out of the synth.
 *
 * Because `sampleAt()` is pure, serving bytes 1_000_000–1_500_000 costs exactly
 * the same as serving the first 500 kB — so seeking in the player is instant and
 * memory-flat. A tiny LRU keeps recently played tracks fully rendered so
 * scrubbing in one song doesn't re-synthesise it.
 */

import type { Track } from "../types";
import { RENDER_RATE, trackSampleCount, renderRange } from "./synth";
import { WAV_HEADER_BYTES, wavByteLength } from "./wav";
import { sharedState } from "../util";

export interface AudioGeometry {
  sampleCount: number;
  totalBytes: number;
  durationSec: number;
  sampleRate: number;
}

export function geometryFor(track: Track, rate = RENDER_RATE): AudioGeometry {
  const sampleCount = trackSampleCount(track.spec, rate);
  return {
    sampleCount,
    totalBytes: wavByteLength(sampleCount),
    durationSec: sampleCount / rate,
    sampleRate: rate,
  };
}

/** Build the 44-byte header for the *full* file (so duration metadata stays right). */
function fullHeader(sampleCount: number, sampleRate: number): Uint8Array {
  const dataBytes = sampleCount * 2;
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/** Render an arbitrary byte window of the (virtual) WAV file. */
export function renderWavBytes(track: Track, startByte: number, endByte: number, rate = RENDER_RATE): Uint8Array {
  const geo = geometryFor(track, rate);
  const start = Math.max(0, Math.min(startByte, geo.totalBytes - 1));
  const end = Math.max(start, Math.min(endByte, geo.totalBytes - 1));
  const length = end - start + 1;
  const out = new Uint8Array(length);

  // header bytes that fall inside the requested window
  if (start < WAV_HEADER_BYTES) {
    const header = fullHeader(geo.sampleCount, geo.sampleRate);
    const headerEnd = Math.min(WAV_HEADER_BYTES, end + 1);
    out.set(header.subarray(start, headerEnd), 0);
  }

  const dataStart = Math.max(start, WAV_HEADER_BYTES);
  if (dataStart <= end) {
    // Ranges can start/end mid-sample, so map bytes -> samples by absolute byte
    // position and copy byte-by-byte. This keeps every alignment exact.
    const firstSample = Math.floor((dataStart - WAV_HEADER_BYTES) / 2);
    const lastSample = Math.floor((end - WAV_HEADER_BYTES) / 2);
    const samples = renderRange(track.spec, firstSample, lastSample - firstSample + 1, rate);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
      const value = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      const lo = value & 0xff;
      const hi = (value >> 8) & 0xff;
      const base = WAV_HEADER_BYTES + (firstSample + i) * 2;
      const posLo = base - start;
      if (posLo >= 0 && posLo < length) out[posLo] = lo;
      const posHi = posLo + 1;
      if (posHi >= 0 && posHi < length) out[posHi] = hi;
    }
  }

  return out;
}

/* ------------------------------------------------------------- LRU cache ---- */

const CACHE_LIMIT = 4;
const cache = sharedState<Map<string, Uint8Array>>("wav-cache", () => new Map());

export function fullWavCached(track: Track, rate = RENDER_RATE): Uint8Array {
  const key = `${track.id}:${rate}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const geo = geometryFor(track, rate);
  const bytes = renderWavBytes(track, 0, geo.totalBytes - 1, rate);
  cache.set(key, bytes);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return bytes;
}

export function clearStreamCache(): void {
  cache.clear();
}

/** Parse an HTTP Range header against a total byte length. */
export function parseRange(header: string | null, totalBytes: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? totalBytes - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalBytes) return null;
  return { start, end: Math.min(end, totalBytes - 1) };
}
