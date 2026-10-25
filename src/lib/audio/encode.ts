/**
 * Turn a synthesised track into a *specific* audio quality, for playback and
 * for downloads.
 *
 *   quality ─► render the spec at that sample rate (8k…48k)
 *                 ├─ MP3 rung  → LAME encode (32…320 kbps) + ID3v2.3 tag
 *                 └─ WAV rung  → PCM at 8/16/24-bit (byte-range friendly)
 *
 * Full renders are memoised in a byte-budgeted LRU so a second play or a
 * download of the same rung costs nothing. Nothing is written to disk: the
 * synth is the source of truth, so the cache is genuinely disposable.
 */

import type { Track } from "../types";
import { renderRange, trackSampleCount } from "./synth";
import { createMp3Encoder, encodeMp3, wrapMp3 } from "./mp3";
import { encodeWav, type WavBitDepth } from "./wav";
import {
  type AudioQuality,
  estimateBytes,
  extensionForQuality,
  contentTypeForQuality,
} from "./quality";
import { sharedState } from "../util";

export interface EncodedAudio {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
  quality: AudioQuality;
  /** True when the bytes came from the render cache. */
  cached: boolean;
}

const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 32;

interface CacheEntry {
  bytes: Uint8Array;
}

const cache = sharedState<Map<string, CacheEntry>>("quality-render-cache", () => new Map());

function cacheKey(track: Track, quality: AudioQuality): string {
  return `${track.id}:${quality.id}`;
}

function cacheGet(key: string): Uint8Array | null {
  const hit = cache.get(key);
  if (!hit) return null;
  // refresh LRU position
  cache.delete(key);
  cache.set(key, hit);
  return hit.bytes;
}

function cacheSet(key: string, bytes: Uint8Array): void {
  cache.set(key, { bytes });
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes.byteLength;
  while (cache.size > CACHE_MAX_ENTRIES || (total > CACHE_BUDGET_BYTES && cache.size > 1)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    total -= cache.get(oldest)?.bytes.byteLength ?? 0;
    cache.delete(oldest);
  }
}

export function clearQualityCache(): void {
  cache.clear();
}

export function qualityCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.bytes.byteLength;
  return { entries: cache.size, bytes };
}

/** Render the whole track at the rung's sample rate. */
export function renderTrackSamples(track: Track, quality: AudioQuality): Float32Array {
  const count = trackSampleCount(track.spec, quality.sampleRate);
  return renderRange(track.spec, 0, count, quality.sampleRate);
}

/** ID3 metadata for a rendered MP3. */
export function tagsFor(track: Track, quality: AudioQuality) {
  return {
    title: track.nativeTitle ? `${track.title} (${track.nativeTitle})` : track.title,
    artist: track.artist,
    album: track.album,
    year: track.year,
    genre: track.genres[0],
    bpm: track.bpm,
    comment: `SongHub · ${quality.label} · ${quality.sampleRate / 1000} kHz mono · synthesised ${new Date().toISOString().slice(0, 10)}`,
  };
}

/** Encode a whole track at a rung (memoised). */
export function encodeTrackAudio(track: Track, quality: AudioQuality): EncodedAudio {
  const key = cacheKey(track, quality);
  const hit = cacheGet(key);
  if (hit) {
    return {
      bytes: hit,
      contentType: contentTypeForQuality(quality),
      extension: extensionForQuality(quality),
      quality,
      cached: true,
    };
  }

  const samples = renderTrackSamples(track, quality);
  const bytes =
    quality.family === "mp3"
      ? wrapMp3(encodeMp3(samples, quality.sampleRate, quality.bitrateKbps ?? 128), tagsFor(track, quality))
      : encodeWav(samples, quality.sampleRate, 1, (quality.bitDepth ?? 16) as WavBitDepth);

  cacheSet(key, bytes);
  return {
    bytes,
    contentType: contentTypeForQuality(quality),
    extension: extensionForQuality(quality),
    quality,
    cached: false,
  };
}

/**
 * Stream an MP3 while it is being synthesised, so playback starts in a few
 * hundred milliseconds instead of waiting for a multi-second full render.
 * The completed file is dropped into the cache for the next listener.
 */
export function streamTrackMp3(track: Track, quality: AudioQuality): ReadableStream<Uint8Array> {
  const key = cacheKey(track, quality);
  const cached = cacheGet(key);
  if (cached) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(cached);
        controller.close();
      },
    });
  }

  const sampleRate = quality.sampleRate;
  const kbps = quality.bitrateKbps ?? 128;
  const totalSamples = trackSampleCount(track.spec, sampleRate);
  // One second of audio per pull keeps latency low without drowning the event loop.
  const blockSamples = Math.max(4096, Math.round(sampleRate));
  let cursor = 0;
  const collected: Uint8Array[] = [];
  let encoder: ReturnType<typeof createMp3Encoder> | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(wrapMp3(new Uint8Array(0), tagsFor(track, quality)));
    },
    pull(controller) {
      encoder ??= createMp3Encoder(sampleRate, kbps);
      if (cursor >= totalSamples) {
        const tail = encoder.finish();
        if (tail.length) {
          controller.enqueue(tail);
          collected.push(tail);
        }
        const combined = collected.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        if (combined > 0) cacheSet(key, concatBytes(collected));
        controller.close();
        return;
      }
      const count = Math.min(blockSamples, totalSamples - cursor);
      const samples = renderRange(track.spec, cursor, count, sampleRate);
      cursor += count;
      const encoded = encoder.push(samples);
      if (encoded.length) {
        controller.enqueue(encoded);
        collected.push(encoded);
      }
    },
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `Artist - Title - 128kbps.mp3` (filesystem-safe, Devanagari preserved). */
export function downloadFileName(track: Track, quality: AudioQuality): string {
  const safe = (value: string) => value.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
  const label = quality.family === "mp3" ? `${quality.bitrateKbps}kbps` : `${quality.sampleRate / 1000}k-${quality.bitDepth}bit`;
  return `${safe(track.artist)} - ${safe(track.title)} - ${label}.${extensionForQuality(quality)}`;
}

/** Size a download will be, for the UI (exact for WAV, estimated for MP3). */
export function expectedBytes(track: Track, quality: AudioQuality): number {
  return estimateBytes(track.duration, quality);
}
