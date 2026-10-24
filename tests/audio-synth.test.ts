import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RATE,
  RENDER_RATE,
  analyzePcm,
  estimatePitch,
  renderRange,
  renderTrack,
  sampleAt,
  trackDurationSec,
  trackSampleCount,
} from "@/lib/audio/synth";
import { decodeWav, encodeWav, normalize, resampleMono, wavByteLength, WAV_HEADER_BYTES } from "@/lib/audio/wav";
import { TRACKS } from "@/lib/catalog/tracks";
import type { TrackSpec } from "@/lib/types";

const spec = (over: Partial<TrackSpec> = {}): TrackSpec => ({
  root: 45,
  scale: [0, 2, 3, 5, 7, 8, 10],
  progression: [0, 5, 3, 4],
  bpm: 96,
  bars: 8,
  voices: { pad: true, bass: true, arp: true, drums: true, pluck: true, shimmer: true },
  swing: 0.1,
  gain: 1.1,
  seed: 4242,
  ...over,
});

describe("timing helpers", () => {
  it("computes duration from bars and bpm", () => {
    expect(trackDurationSec(spec({ bpm: 120, bars: 4 }))).toBeCloseTo(8, 6);
  });
  it("computes sample count at render rate", () => {
    const s = spec({ bpm: 120, bars: 4 });
    expect(trackSampleCount(s, 1000)).toBe(8000);
  });
  it("computes sample count at analysis rate", () => {
    const s = spec({ bpm: 120, bars: 4 });
    expect(trackSampleCount(s, ANALYSIS_RATE)).toBe(8 * ANALYSIS_RATE);
  });
  it("never returns zero samples", () => {
    expect(trackSampleCount(spec({ bars: 0 }))).toBeGreaterThan(0);
  });
});

describe("sampleAt purity", () => {
  it("is deterministic for the same input", () => {
    const s = spec();
    for (const t of [0, 0.5, 3.7, 12.25, 19.9]) expect(sampleAt(s, t)).toBe(sampleAt(s, t));
  });
  it("is silent past the end of the track", () => {
    const s = spec({ bars: 2, bpm: 120 });
    expect(sampleAt(s, trackDurationSec(s) + 1)).toBe(0);
  });
  it("is silent before time zero", () => {
    expect(sampleAt(spec(), -1)).toBe(0);
  });
  it("fades in from silence", () => {
    const s = spec();
    expect(Math.abs(sampleAt(s, 0))).toBeLessThan(0.05);
  });
  it("stays inside [-1, 1] across a whole bar", () => {
    const s = spec();
    for (let i = 0; i < 2000; i++) {
      const v = sampleAt(s, i * 0.005);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it("produces a non-zero signal in the body of the track", () => {
    const s = spec();
    let energy = 0;
    for (let i = 0; i < 500; i++) energy += Math.abs(sampleAt(s, 2 + i * 0.004));
    expect(energy).toBeGreaterThan(1);
  });
});

describe("voice gating", () => {
  const silentVoices: TrackSpec["voices"] = { pad: false, bass: false, arp: false, drums: false, pluck: false, shimmer: false };
  it("renders silence when no voices are enabled", () => {
    const s = spec({ voices: silentVoices });
    let energy = 0;
    for (let i = 0; i < 1000; i++) energy += Math.abs(sampleAt(s, 1 + i * 0.003));
    expect(energy).toBeLessThan(1e-6);
  });
  const voiceNames = ["pad", "bass", "arp", "drums", "pluck", "shimmer"] as const;
  for (const voice of voiceNames) {
    it(`produces audible output with only ${voice} enabled`, () => {
      const s = spec({ voices: { ...silentVoices, [voice]: true } });
      let energy = 0;
      for (let i = 0; i < 4000; i++) energy += Math.abs(sampleAt(s, 1 + i * 0.0025));
      expect(energy, voice).toBeGreaterThan(0.05);
    });
  }
});

describe("determinism across seeds and parameters", () => {
  for (const seed of [1, 2, 3, 99, 12345]) {
    it(`seed ${seed} renders identical audio twice`, () => {
      const a = renderRange(spec({ seed }), 0, 3000, 8000);
      const b = renderRange(spec({ seed }), 0, 3000, 8000);
      expect(Array.from(a)).toEqual(Array.from(b));
    });
  }
  it("different seeds produce different audio", () => {
    const a = renderRange(spec({ seed: 1 }), 0, 3000, 8000);
    const b = renderRange(spec({ seed: 2 }), 0, 3000, 8000);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
  it("different tempos produce different audio", () => {
    const a = renderRange(spec({ bpm: 90 }), 0, 3000, 8000);
    const b = renderRange(spec({ bpm: 140 }), 0, 3000, 8000);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe("renderRange", () => {
  const s = spec();
  it("matches sampleAt for the same window", () => {
    const start = 4800;
    const out = renderRange(s, start, 64, 8000);
    for (let i = 0; i < 64; i++) {
      expect(out[i]).toBeCloseTo(sampleAt(s, (start + i) / 8000), 6);
    }
  });
  it("is equivalent to slicing a full render (seek accuracy)", () => {
    const rate = 8000;
    const full = renderRange(s, 0, 8000, rate);
    const slice = renderRange(s, 3000, 1000, rate);
    for (let i = 0; i < 1000; i += 97) expect(slice[i]).toBeCloseTo(full[3000 + i], 6);
  });
  it("returns the requested length", () => {
    expect(renderRange(s, 0, 1234, 8000)).toHaveLength(1234);
  });
  it("returns silence past the end", () => {
    const far = renderRange(s, trackSampleCount(s, 8000) + 100, 100, 8000);
    expect(Array.from(far).every((v) => v === 0)).toBe(true);
  });
});

describe("full catalog renders", () => {
  for (const track of TRACKS) {
    it(`${track.id}: renders to the declared duration`, () => {
      const samples = trackSampleCount(track.spec, ANALYSIS_RATE);
      expect(samples / ANALYSIS_RATE).toBeCloseTo(trackDurationSec(track.spec), 3);
      expect(Math.abs(track.duration - trackDurationSec(track.spec))).toBeLessThan(1.01);
    });
    it(`${track.id}: has audio energy and stays in range`, () => {
      const n = Math.min(trackSampleCount(track.spec, ANALYSIS_RATE), ANALYSIS_RATE * 3);
      const audio = renderRange(track.spec, 0, n, ANALYSIS_RATE);
      const stats = analyzePcm(audio, ANALYSIS_RATE);
      expect(stats.rms).toBeGreaterThan(0.01);
      expect(stats.peakAmplitude).toBeLessThanOrEqual(1);
      expect(stats.peakAmplitude).toBeGreaterThan(0.1);
    });
    it(`${track.id}: renders identically on repeat`, () => {
      const a = renderRange(track.spec, 0, 2000, ANALYSIS_RATE);
      const b = renderRange(track.spec, 0, 2000, ANALYSIS_RATE);
      expect(Array.from(a)).toEqual(Array.from(b));
    });
  }
});

describe("WAV encoding", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);

  it("writes a RIFF/WAVE header", () => {
    const bytes = encodeWav(samples, 8000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
  });
  it("declares the right byte length", () => {
    const bytes = encodeWav(samples, 8000);
    expect(bytes.byteLength).toBe(wavByteLength(samples.length));
    expect(bytes.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2);
  });
  it("declares sample rate and channels", () => {
    const bytes = encodeWav(samples, 22050);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(34, true)).toBe(16);
  });
  it("round-trips through the decoder", () => {
    const bytes = encodeWav(samples, 8000);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.samples).toHaveLength(samples.length);
    for (let i = 0; i < samples.length; i++) expect(decoded.samples[i]).toBeCloseTo(samples[i], 3);
  });
  it("clips values outside [-1,1]", () => {
    const bytes = encodeWav(new Float32Array([2, -2]), 8000);
    const decoded = decodeWav(bytes);
    expect(decoded.samples[0]).toBeCloseTo(1, 3);
    expect(decoded.samples[1]).toBeCloseTo(-1, 3);
  });
  it("rejects non-WAV buffers", () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => decodeWav(new Uint8Array(100))).toThrow();
  });
  it("round-trips a rendered track chunk", () => {
    const audio = renderRange(spec(), 0, 512, 8000);
    const decoded = decodeWav(encodeWav(audio, 8000));
    for (let i = 0; i < 512; i += 37) expect(decoded.samples[i]).toBeCloseTo(audio[i], 3);
  });
});

describe("resampleMono", () => {
  it("returns the same array at the same rate", () => {
    const input = new Float32Array([1, 2, 3]);
    expect(resampleMono(input, 8000, 8000)).toBe(input);
  });
  it("halves length when halving the rate", () => {
    const input = new Float32Array(1000).fill(0.5);
    expect(resampleMono(input, 16000, 8000)).toHaveLength(500);
  });
  it("doubles length when doubling the rate", () => {
    const input = new Float32Array(1000).fill(0.5);
    expect(resampleMono(input, 8000, 16000)).toHaveLength(2000);
  });
  it("preserves a constant signal", () => {
    const input = new Float32Array(800).fill(0.25);
    const out = resampleMono(input, 44100, 8000);
    for (let i = 10; i < out.length - 10; i++) expect(out[i]).toBeCloseTo(0.25, 5);
  });
  it("never returns an empty array", () => {
    expect(resampleMono(new Float32Array(1), 44100, 8000).length).toBeGreaterThan(0);
  });
});

describe("normalize", () => {
  it("scales the peak to the requested value", () => {
    const out = normalize(new Float32Array([0.1, -0.2, 0.05]));
    expect(Math.max(...Array.from(out).map(Math.abs))).toBeCloseTo(0.92, 5);
  });
  it("leaves silence alone", () => {
    const out = normalize(new Float32Array([0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
  it("respects a custom peak", () => {
    const out = normalize(new Float32Array([0.5, -0.5]), 0.5);
    expect(Math.max(...Array.from(out).map(Math.abs))).toBeCloseTo(0.5, 5);
  });
});

describe("analyzePcm", () => {
  it("measures silence", () => {
    const stats = analyzePcm(new Float32Array(100), 8000);
    expect(stats.rms).toBe(0);
    expect(stats.peakAmplitude).toBe(0);
  });
  it("measures a full-scale square wave", () => {
    const samples = new Float32Array(100);
    for (let i = 0; i < 100; i++) samples[i] = i % 2 ? 1 : -1;
    const stats = analyzePcm(samples, 8000);
    expect(stats.peakAmplitude).toBe(1);
    expect(stats.rms).toBeCloseTo(1, 5);
    expect(stats.zeroCrossingRate).toBeGreaterThan(0.9);
  });
  it("reports duration from sample count", () => {
    expect(analyzePcm(new Float32Array(8000), 8000).durationSec).toBe(1);
  });
});

describe("estimatePitch", () => {
  for (const freq of [110, 220, 440, 880]) {
    it(`detects a ${freq} Hz tone within 3%`, () => {
      const rate = 8000;
      const samples = new Float32Array(4096);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * freq * i) / rate);
      const pitch = estimatePitch(samples, rate);
      expect(Math.abs(pitch - freq) / freq).toBeLessThan(0.03);
    });
  }
  it("returns 0 for a clip that is too short", () => {
    expect(estimatePitch(new Float32Array(10), 8000)).toBe(0);
  });
});

describe("render rates", () => {
  it("analysis rate is below render rate", () => {
    expect(ANALYSIS_RATE).toBeLessThan(RENDER_RATE);
  });
  it("render rate is a sane audio rate", () => {
    expect(RENDER_RATE).toBeGreaterThanOrEqual(16000);
    expect(RENDER_RATE).toBeLessThanOrEqual(48000);
  });
  it("analysis rate keeps enough bandwidth for fingerprints", () => {
    expect(ANALYSIS_RATE).toBeGreaterThanOrEqual(8000);
  });
  it("full render of a track has the expected sample count", () => {
    const track = TRACKS[0];
    const audio = renderTrack(track.spec, 4000);
    expect(audio.length).toBe(trackSampleCount(track.spec, 4000));
  });
});
