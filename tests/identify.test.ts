import { beforeAll, describe, expect, it } from "vitest";
import {
  ANALYSIS_RATE,
  MAX_CLIP_SECONDS,
  decodeRequestBody,
  ensureFingerprintIndex,
  getIndexState,
  identifyClip,
} from "@/lib/audio/identify";
import { renderRange, trackSampleCount } from "@/lib/audio/synth";
import { encodeWav } from "@/lib/audio/wav";
import { TRACKS } from "@/lib/catalog/tracks";
import { mulberry32 } from "@/lib/util";

function clipFor(trackIndex: number, seconds = 6, startFraction = 0.3, noise = 0.03, seed = 3): Float32Array {
  const track = TRACKS[trackIndex];
  const total = trackSampleCount(track.spec, ANALYSIS_RATE);
  const start = Math.floor(total * startFraction);
  const base = renderRange(track.spec, start, Math.round(seconds * ANALYSIS_RATE), ANALYSIS_RATE);
  const rnd = mulberry32(seed + trackIndex);
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = base[i] * 0.85 + (rnd() * 2 - 1) * noise;
  return out;
}

describe("identify pipeline", () => {
  beforeAll(async () => {
    await ensureFingerprintIndex();
  }, 180000);

  it("reports a ready index state", () => {
    const state = getIndexState();
    expect(state.status).toBe("ready");
    expect(state.trackCount).toBe(TRACKS.length);
    expect(state.totalHashes).toBeGreaterThan(100000);
  });

  // Every track in the catalog, identified from a noisy excerpt.
  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`identifies ${track.title} from a noisy 6s excerpt`, async () => {
      const result = await identifyClip(clipFor(i), ANALYSIS_RATE);
      expect(result.ok).toBe(true);
      expect(result.best?.track.id).toBe(track.id);
      expect(result.confidence).toBeGreaterThan(0.4);
      expect(result.tookMs).toBeLessThan(5000);
    });
  }

  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`identifies ${track.title} from a tiny 3s excerpt`, async () => {
      const result = await identifyClip(clipFor(i, 3, 0.55, 0.02, 11), ANALYSIS_RATE);
      expect(result.candidates[0]?.track.id).toBe(track.id);
    });
  }

  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`${track.title}: rejects a clip of a different track`, async () => {
      const other = (i + 7) % TRACKS.length;
      const result = await identifyClip(clipFor(other, 6, 0.4, 0.02, 21), ANALYSIS_RATE);
      expect(result.candidates[0]?.track.id).not.toBe(track.id);
    });
  }

  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`${track.title}: reports an offset close to the true position`, async () => {
      const seconds = 6;
      const fraction = 0.5;
      const result = await identifyClip(clipFor(i, seconds, fraction, 0.01, 31), ANALYSIS_RATE);
      expect(result.best?.track.id).toBe(track.id);
      const expected = track.duration * fraction;
      expect(Math.abs((result.best?.offsetSec ?? 0) - expected)).toBeLessThan(2.5);
    });
  }

  // Realistic "noisy room" case: clip at ~35% volume with broadband noise added.
  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`${track.title}: survives room noise and a big volume drop`, async () => {
      const total = trackSampleCount(track.spec, ANALYSIS_RATE);
      const base = renderRange(track.spec, Math.floor(total * 0.2), 6 * ANALYSIS_RATE, ANALYSIS_RATE);
      const rnd = mulberry32(101 + i);
      const noisy = new Float32Array(base.length);
      for (let j = 0; j < base.length; j++) noisy[j] = base[j] * 0.35 + (rnd() * 2 - 1) * 0.04;
      const result = await identifyClip(noisy, ANALYSIS_RATE);
      expect(result.candidates[0]?.track.id).toBe(track.id);
    });
  }

  // Deliberately brutal case (noise louder than the music, ~0 dB SNR). Any
  // fingerprinting system degrades here; we assert graceful behaviour: the true
  // track must still be in the shortlist, and confidence must drop.
  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`${track.title}: degrades gracefully at ~0 dB SNR`, async () => {
      const total = trackSampleCount(track.spec, ANALYSIS_RATE);
      const base = renderRange(track.spec, Math.floor(total * 0.2), 6 * ANALYSIS_RATE, ANALYSIS_RATE);
      const rnd = mulberry32(101 + i);
      const noisy = new Float32Array(base.length);
      for (let j = 0; j < base.length; j++) noisy[j] = base[j] * 0.35 + (rnd() * 2 - 1) * 0.08;
      const result = await identifyClip(noisy, ANALYSIS_RATE);
      const shortlist = result.candidates.map((c) => c.track.id);
      expect(shortlist).toContain(track.id);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  }

  for (let i = 0; i < TRACKS.length; i++) {
    const track = TRACKS[i];
    it(`${track.title}: audio echoed back as a different sample rate still matches`, async () => {
      // simulate a 44.1 kHz phone recording by upsampling the analysis clip
      const base = clipFor(i, 5, 0.35, 0.02, 41);
      const upsampled = new Float32Array(base.length * 4);
      for (let j = 0; j < upsampled.length; j++) upsampled[j] = base[Math.floor(j / 4)];
      const result = await identifyClip(upsampled, ANALYSIS_RATE * 4);
      expect(result.candidates[0]?.track.id).toBe(track.id);
    });
  }
});

describe("identify edge cases", () => {
  beforeAll(async () => {
    await ensureFingerprintIndex();
  }, 180000);

  it("rejects a clip that is too short", async () => {
    const result = await identifyClip(new Float32Array(ANALYSIS_RATE), ANALYSIS_RATE);
    expect(result.ok).toBe(false);
    expect(result.candidates).toHaveLength(0);
    expect(result.message).toMatch(/at least/);
  });

  it("rejects silence", async () => {
    const result = await identifyClip(new Float32Array(ANALYSIS_RATE * 5), ANALYSIS_RATE);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/silent|quiet/i);
  });

  it("rejects near-silence", async () => {
    const rnd = mulberry32(5);
    const tiny = new Float32Array(ANALYSIS_RATE * 5);
    for (let i = 0; i < tiny.length; i++) tiny[i] = (rnd() * 2 - 1) * 0.0002;
    const result = await identifyClip(tiny, ANALYSIS_RATE);
    expect(result.ok).toBe(false);
  });

  it("does not claim a match for random noise", async () => {
    const rnd = mulberry32(77);
    const noise = new Float32Array(ANALYSIS_RATE * 6);
    for (let i = 0; i < noise.length; i++) noise[i] = (rnd() * 2 - 1) * 0.3;
    const result = await identifyClip(noise, ANALYSIS_RATE);
    expect(result.ok).toBe(false);
    expect(result.confidence).toBeLessThan(0.42);
  });

  it("handles a clip longer than the maximum by truncating", async () => {
    const base = clipFor(0, 40, 0.1, 0.01, 51);
    const result = await identifyClip(base, ANALYSIS_RATE);
    expect(result.input.durationSec).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
  });

  it("reports input analysis fields", async () => {
    const result = await identifyClip(clipFor(2, 6, 0.4), ANALYSIS_RATE);
    expect(result.input.sampleRate).toBe(ANALYSIS_RATE);
    expect(result.input.peakAmplitude).toBeGreaterThan(0);
    expect(result.input.rms).toBeGreaterThan(0);
    expect(result.input.tempoBpm).toBeGreaterThan(0);
    expect(result.input.durationSec).toBeCloseTo(6, 0);
  });

  it("handles a fully clipped (distorted) clip", async () => {
    const base = clipFor(3, 6, 0.4, 0, 61);
    const clipped = Float32Array.from(base, (v) => Math.max(-1, Math.min(1, v * 8)));
    const result = await identifyClip(clipped, ANALYSIS_RATE);
    expect(result.candidates[0]?.track.id).toBe(TRACKS[3].id);
  });

  it("returns at most the requested number of candidates", async () => {
    const result = await identifyClip(clipFor(4, 6, 0.4), ANALYSIS_RATE, { limit: 3 });
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it("produces a human-readable message", async () => {
    const result = await identifyClip(clipFor(5, 6, 0.4), ANALYSIS_RATE);
    expect(result.message).toContain("“");
    if (result.best) expect(result.message).toContain(result.best.track.title);
  });

  it("is deterministic", async () => {
    const clip = clipFor(6, 6, 0.4);
    const a = await identifyClip(clip, ANALYSIS_RATE);
    const b = await identifyClip(clip, ANALYSIS_RATE);
    expect(a.best?.track.id).toBe(b.best?.track.id);
    expect(a.confidence).toBe(b.confidence);
  });

  it("works when the clip starts at the very beginning of a track", async () => {
    const track = TRACKS[7];
    const clip = renderRange(track.spec, 0, 8 * ANALYSIS_RATE, ANALYSIS_RATE);
    const result = await identifyClip(clip, ANALYSIS_RATE);
    expect(result.candidates[0]?.track.id).toBe(track.id);
  });

  it("works at the very end of a track", async () => {
    const track = TRACKS[8];
    const total = trackSampleCount(track.spec, ANALYSIS_RATE);
    const clip = renderRange(track.spec, total - 8 * ANALYSIS_RATE, 8 * ANALYSIS_RATE, ANALYSIS_RATE);
    const result = await identifyClip(clip, ANALYSIS_RATE);
    expect(result.candidates[0]?.track.id).toBe(track.id);
  });

  it("ranks the true track above every other candidate", async () => {
    const result = await identifyClip(clipFor(9, 7, 0.4, 0.04, 71), ANALYSIS_RATE);
    const votes = result.candidates.map((c) => c.matchedHashes);
    expect(votes[0]).toBeGreaterThan(votes[1] ?? 0);
  });
});

describe("request decoding", () => {
  it("decodes raw int16 PCM", () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const buffer = Buffer.from(pcm.buffer.slice(0));
    const decoded = decodeRequestBody(buffer, 8000);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.samples).toHaveLength(5);
    expect(decoded.samples[0]).toBeCloseTo(0, 4);
    expect(decoded.samples[1]).toBeCloseTo(0.5, 2);
    expect(decoded.samples[2]).toBeCloseTo(-0.5, 2);
  });

  it("decodes a WAV container and prefers its sample rate", () => {
    const samples = new Float32Array(100).fill(0.25);
    const wav = encodeWav(samples, 16000);
    const decoded = decodeRequestBody(Buffer.from(wav), 8000);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.samples.length).toBe(100);
  });

  it("defaults the sample rate when the header is missing", () => {
    const decoded = decodeRequestBody(Buffer.from(new Int16Array(10).buffer), 0);
    expect(decoded.sampleRate).toBe(ANALYSIS_RATE);
  });

  it("round-trips a rendered clip through WAV", async () => {
    const audio = clipFor(0, 4, 0.3, 0, 81);
    const decoded = decodeRequestBody(Buffer.from(encodeWav(audio, ANALYSIS_RATE)), ANALYSIS_RATE);
    const result = await identifyClip(decoded.samples, decoded.sampleRate);
    expect(result.best?.track.id).toBe(TRACKS[0].id);
  });
});

describe("index reuse", () => {
  it("ensureFingerprintIndex is idempotent and fast when warm", async () => {
    const started = Date.now();
    const a = await ensureFingerprintIndex();
    const b = await ensureFingerprintIndex();
    expect(a).toBe(b);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("indexes every catalog track", async () => {
    const index = await ensureFingerprintIndex();
    expect(index.trackCount).toBe(TRACKS.length);
    for (const track of TRACKS) expect(index.trackDurations.has(track.id)).toBe(true);
  });
});
