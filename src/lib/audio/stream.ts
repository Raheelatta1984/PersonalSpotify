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
import { WAV_HEADER_BYTES, wavByteLength, type WavBitDepth } from "./wav";
import { sharedState } from "../util";

export interface AudioGeometry {
  sampleCount: number;
  totalBytes: number;
  durationSec: number;
  sampleRate: number;
  bitDepth: WavBitDepth;
  bytesPerSample: number;
}

export function geometryFor(track: Track, rate = RENDER_RATE, bitDepth: WavBitDepth = 16): AudioGeometry {
  const sampleCount = trackSampleCount(track.spec, rate);
  return {
    sampleCount,
    totalBytes: wavByteLength(sampleCount, 1, bitDepth),
    durationSec: sampleCount / rate,
    sampleRate: rate,
    bitDepth,
    bytesPerSample: bitDepth / 8,
  };
}

/** Build the 44-byte header for the *full* file (so duration metadata stays right). */
function fullHeader(sampleCount: number, sampleRate: number, bitDepth: WavBitDepth = 16): Uint8Array {
  const bytesPerSample = bitDepth / 8;
  const dataBytes = Math.ceil(sampleCount * bytesPerSample);
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
  view.setUint32(28, Math.round(sampleRate * bytesPerSample), true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Render an arbitrary byte window of the (virtual) WAV file.
 * Works for 8-, 16- and 24-bit PCM, and for any sample rate the synth can render.
 */
export function renderWavBytes(
  track: Track,
  startByte: number,
  endByte: number,
  rate = RENDER_RATE,
  bitDepth: WavBitDepth = 16,
): Uint8Array {
  const geo = geometryFor(track, rate, bitDepth);
  const bps = geo.bytesPerSample;
  const start = Math.max(0, Math.min(startByte, geo.totalBytes - 1));
  const end = Math.max(start, Math.min(endByte, geo.totalBytes - 1));
  const length = end - start + 1;
  const out = new Uint8Array(length);

  // header bytes that fall inside the requested window
  if (start < WAV_HEADER_BYTES) {
    const header = fullHeader(geo.sampleCount, geo.sampleRate, bitDepth);
    const headerEnd = Math.min(WAV_HEADER_BYTES, end + 1);
    out.set(header.subarray(start, headerEnd), 0);
  }

  const dataStart = Math.max(start, WAV_HEADER_BYTES);
  if (dataStart <= end) {
    // Ranges can start/end mid-sample, so map bytes -> samples by absolute byte
    // position and write sample-by-sample. This keeps every alignment exact.
    const firstSample = Math.floor((dataStart - WAV_HEADER_BYTES) / bps);
    const lastSample = Math.floor((end - WAV_HEADER_BYTES) / bps);
    const samples = renderRange(track.spec, firstSample, lastSample - firstSample + 1, rate);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
      const base = WAV_HEADER_BYTES + (firstSample + i) * bps;
      if (bitDepth === 24) {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)));
        writeByte(out, base - start, length, v & 0xff);
        writeByte(out, base - start + 1, length, (v >> 8) & 0xff);
        writeByte(out, base - start + 2, length, (v >> 16) & 0xff);
      } else if (bitDepth === 8) {
        writeByte(out, base - start, length, Math.max(0, Math.min(255, Math.round(s * 127) + 128)));
      } else {
        const value = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
        writeByte(out, base - start, length, value & 0xff);
        writeByte(out, base - start + 1, length, (value >> 8) & 0xff);
      }
    }
  }

  return out;
}

function writeByte(out: Uint8Array, position: number, length: number, value: number) {
  if (position >= 0 && position < length) out[position] = value;
}

/* ------------------------------------------------------------- LRU cache ---- */

const CACHE_LIMIT = 4;
const cache = sharedState<Map<string, Uint8Array>>("wav-cache", () => new Map());

export function fullWavCached(track: Track, rate = RENDER_RATE, bitDepth: WavBitDepth = 16): Uint8Array {
  const key = `${track.id}:${rate}:${bitDepth}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const geo = geometryFor(track, rate, bitDepth);
  const bytes = renderWavBytes(track, 0, geo.totalBytes - 1, rate, bitDepth);
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
