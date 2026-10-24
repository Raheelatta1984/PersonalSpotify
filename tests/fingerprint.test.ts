import { beforeAll, describe, expect, it } from "vitest";
import {
  FAN_OUT,
  FFT_SIZE,
  HOP_SIZE,
  confidenceFromVotes,
  extractPeaks,
  fft,
  fingerprintSamples,
  hashesFromPeaks,
  matchHashes,
  pairHash,
  spectrogram,
  type MatchIndex,
} from "@/lib/audio/fingerprint";
import { ANALYSIS_RATE, renderRange, trackSampleCount } from "@/lib/audio/synth";
import { TRACKS } from "@/lib/catalog/tracks";
import { mulberry32 } from "@/lib/util";

/** Naive DFT used as a reference implementation in the FFT test. */
function dft(signal: Float32Array): { re: Float64Array; im: Float64Array } {
  const n = signal.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      sumRe += signal[t] * Math.cos(angle);
      sumIm += signal[t] * Math.sin(angle);
    }
    re[k] = sumRe;
    im[k] = sumIm;
  }
  return { re, im };
}

function tone(freq: number, seconds: number, rate = ANALYSIS_RATE, amp = 0.6): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return samples;
}

function addNoise(samples: Float32Array, level: number, seed = 7): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] + (rnd() * 2 - 1) * level;
  return out;
}

/** Render an excerpt of a catalog track by id. */
function excerpt(trackId: string, startSec: number, seconds: number): Float32Array {
  const track = TRACKS.find((t) => t.id === trackId)!;
  const start = Math.round(startSec * ANALYSIS_RATE);
  return renderRange(track.spec, start, Math.round(seconds * ANALYSIS_RATE), ANALYSIS_RATE);
}

describe("fft", () => {
  it("matches a naive DFT (8-point signal, zero-padded)", () => {
    const small = [1, 0.5, -0.25, 0.75, 0, -0.5, 0.1, 0.2];
    const signal = new Float32Array(small.length);
    for (let i = 0; i < small.length; i++) signal[i] = small[i];
    const re = Float32Array.from(signal);
    const im = new Float32Array(signal.length);
    fft(re, im);
    const ref = dft(signal);
    for (let k = 0; k < signal.length; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 4);
      expect(im[k]).toBeCloseTo(ref.im[k], 4);
    }
  });
  it("matches a naive DFT at the production size", () => {
    const signal = new Float32Array(FFT_SIZE);
    const rnd = mulberry32(5);
    for (let i = 0; i < FFT_SIZE; i++) signal[i] = Math.sin(i * 0.1) + rnd() * 0.2;
    const re = Float32Array.from(signal);
    const im = new Float32Array(FFT_SIZE);
    fft(re, im);
    const ref = dft(signal.subarray(0, 256));
    // compare only the first bins (naive reference runs on a 256-sample prefix)
    for (let k = 1; k < 8; k++) {
      let naiveRe = 0;
      let naiveIm = 0;
      for (let t = 0; t < FFT_SIZE; t++) {
        const angle = (-2 * Math.PI * k * t) / FFT_SIZE;
        naiveRe += signal[t] * Math.cos(angle);
        naiveIm += signal[t] * Math.sin(angle);
      }
      expect(re[k]).toBeCloseTo(naiveRe, 2);
      expect(im[k]).toBeCloseTo(naiveIm, 2);
    }
    expect(ref.re.length).toBe(256);
  });
  it("rejects non power-of-two sizes", () => {
    expect(() => fft(new Float32Array(6), new Float32Array(6))).toThrow();
  });
  it("finds the bin of a pure tone", () => {
    const rate = ANALYSIS_RATE;
    const freq = (FFT_SIZE / 4 / FFT_SIZE) * rate; // bin 256
    const signal = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) signal[i] = Math.sin((2 * Math.PI * freq * i) / rate);
    const re = Float32Array.from(signal);
    const im = new Float32Array(signal.length);
    fft(re, im);
    let bestBin = 0;
    let bestMag = 0;
    for (let b = 0; b < FFT_SIZE / 2; b++) {
      const mag = Math.hypot(re[b], im[b]);
      if (mag > bestMag) {
        bestMag = mag;
        bestBin = b;
      }
    }
    expect(Math.abs(bestBin - 256)).toBeLessThanOrEqual(1);
  });
  it("preserves energy (Parseval, within rounding)", () => {
    const signal = new Float32Array(FFT_SIZE);
    const rnd = mulberry32(11);
    for (let i = 0; i < FFT_SIZE; i++) signal[i] = rnd() * 2 - 1;
    const re = Float32Array.from(signal);
    const im = new Float32Array(signal.length);
    fft(re, im);
    let timeEnergy = 0;
    for (let i = 0; i < FFT_SIZE; i++) timeEnergy += signal[i] ** 2;
    let freqEnergy = 0;
    for (let b = 0; b < FFT_SIZE; b++) freqEnergy += re[b] ** 2 + im[b] ** 2;
    expect(freqEnergy / FFT_SIZE).toBeCloseTo(timeEnergy, 3);
  });
  it("is linear", () => {
    const a = tone(220, FFT_SIZE / ANALYSIS_RATE);
    const b = tone(330, FFT_SIZE / ANALYSIS_RATE);
    const sum = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) sum[i] = a[i] + b[i];
    const ra = Float32Array.from(a);
    const ia = new Float32Array(FFT_SIZE);
    fft(ra, ia);
    const rb = Float32Array.from(b);
    const ib = new Float32Array(FFT_SIZE);
    fft(rb, ib);
    const rs = Float32Array.from(sum);
    const is = new Float32Array(FFT_SIZE);
    fft(rs, is);
    for (let k = 0; k < 32; k++) {
      expect(rs[k]).toBeCloseTo(ra[k] + rb[k], 2);
      expect(is[k]).toBeCloseTo(ia[k] + ib[k], 2);
    }
  });
});

describe("spectrogram", () => {
  it("produces frames of the expected width", () => {
    const spec = spectrogram(tone(440, 1), ANALYSIS_RATE);
    expect(spec.bins).toBe(FFT_SIZE / 2);
    expect(spec.frames.length).toBeGreaterThan(10);
  });
  it("uses a 25 ms hop", () => {
    expect(HOP_SIZE).toBe(400);
  });
  it("returns no frames for a signal shorter than one window", () => {
    expect(spectrogram(new Float32Array(100), ANALYSIS_RATE).frames).toHaveLength(0);
  });
  it("has higher magnitude at the tone's bin", () => {
    const spec = spectrogram(tone(1000, 1), ANALYSIS_RATE);
    const frame = spec.frames[5];
    const expectedBin = Math.round((1000 / ANALYSIS_RATE) * FFT_SIZE);
    let bestBin = 0;
    for (let b = 1; b < frame.length; b++) if (frame[b] > frame[bestBin]) bestBin = b;
    expect(Math.abs(bestBin - expectedBin)).toBeLessThanOrEqual(2);
  });
  it("produces finite values", () => {
    const spec = spectrogram(tone(440, 0.5), ANALYSIS_RATE);
    for (let f = 0; f < spec.frames.length; f += 10) {
      for (let b = 0; b < spec.bins; b += 50) expect(Number.isFinite(spec.frames[f][b])).toBe(true);
    }
  });
});

describe("peak extraction", () => {
  it("finds peaks in a musical excerpt", () => {
    const fp = fingerprintSamples(excerpt("trk_neon_overpass", 10, 5), ANALYSIS_RATE);
    expect(fp.peakCount).toBeGreaterThan(50);
  });
  it("finds none in silence", () => {
    const peaks = extractPeaks(spectrogram(new Float32Array(ANALYSIS_RATE * 2), ANALYSIS_RATE));
    expect(peaks).toHaveLength(0);
  });
  it("limits peaks per frame", () => {
    const peaks = extractPeaks(spectrogram(tone(440, 1), ANALYSIS_RATE));
    const byFrame = new Map<number, number>();
    for (const peak of peaks) byFrame.set(peak.frame, (byFrame.get(peak.frame) ?? 0) + 1);
    for (const count of byFrame.values()) expect(count).toBeLessThanOrEqual(4);
  });
  it("returns peaks sorted by frame", () => {
    const peaks = extractPeaks(spectrogram(excerpt("trk_glass_aster", 5, 4), ANALYSIS_RATE));
    for (let i = 1; i < peaks.length; i++) expect(peaks[i].frame).toBeGreaterThanOrEqual(peaks[i - 1].frame);
  });
  it("ignores the DC bin", () => {
    const peaks = extractPeaks(spectrogram(tone(30, 1), ANALYSIS_RATE));
    for (const peak of peaks) expect(peak.bin).toBeGreaterThanOrEqual(2);
  });
});

describe("pair hashing", () => {
  it("is deterministic", () => {
    expect(pairHash(10, 20, 3)).toBe(pairHash(10, 20, 3));
  });
  it("differs when either frequency differs", () => {
    expect(pairHash(10, 20, 3)).not.toBe(pairHash(11, 20, 3));
    expect(pairHash(10, 20, 3)).not.toBe(pairHash(10, 21, 3));
  });
  it("differs when the time delta differs", () => {
    expect(pairHash(10, 20, 3)).not.toBe(pairHash(10, 20, 4));
  });
  it("stays in the 24-bit range", () => {
    const hash = pairHash(0x1ff, 0x1ff, 0x3f);
    expect(hash).toBeGreaterThan(0);
    expect(hash).toBeLessThan(2 ** 24);
  });
  it("produces at most fan-out pairs per anchor", () => {
    const peaks = [
      { frame: 0, bin: 10, magnitude: 1 },
      { frame: 1, bin: 20, magnitude: 1 },
      { frame: 2, bin: 30, magnitude: 1 },
      { frame: 3, bin: 40, magnitude: 1 },
      { frame: 4, bin: 50, magnitude: 1 },
      { frame: 5, bin: 60, magnitude: 1 },
      { frame: 6, bin: 70, magnitude: 1 },
      { frame: 7, bin: 80, magnitude: 1 },
    ];
    const hashes = hashesFromPeaks(peaks);
    const totalPairs = [...hashes.values()].reduce((n, v) => n + v.length, 0);
    expect(totalPairs).toBeLessThanOrEqual(peaks.length * FAN_OUT);
  });
  it("never pairs a peak with itself", () => {
    const peaks = [{ frame: 5, bin: 100, magnitude: 1 }];
    expect(hashesFromPeaks(peaks).size).toBe(0);
  });
});

describe("matching", () => {
  // A tiny two-track database so we can test both positives and negatives.
  const index: MatchIndex = {
    map: new Map(),
    trackDurations: new Map(),
    totalHashes: 0,
    trackCount: 2,
    builtAt: new Date().toISOString(),
    buildMs: 0,
  };

  beforeAll(() => {
    for (const id of ["trk_neon_overpass", "trk_glacier_letters"]) {
      const fp = fingerprintSamples(excerpt(id, 0, 20), ANALYSIS_RATE);
      index.trackDurations.set(id, 20);
      for (const [hash, times] of fp.hashes) {
        const bucket = index.map.get(hash) ?? [];
        for (const time of times) bucket.push({ trackId: id, time });
        index.map.set(hash, bucket);
        index.totalHashes += times.length;
      }
    }
  });

  it("finds the fingerprint of a clip from the indexed region", () => {
    const query = fingerprintSamples(excerpt("trk_neon_overpass", 5, 5), ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    expect(votes[0]?.trackId).toBe("trk_neon_overpass");
    expect(votes[0].votes).toBeGreaterThan(20);
  });

  it("reports the correct offset for an off-centre clip", () => {
    const query = fingerprintSamples(excerpt("trk_neon_overpass", 12, 5), ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    const offsetSeconds = (votes[0].offset * 400) / ANALYSIS_RATE;
    expect(Math.abs(offsetSeconds - 12)).toBeLessThan(1.5);
  });

  it("distinguishes two different tracks", () => {
    const query = fingerprintSamples(excerpt("trk_glacier_letters", 8, 5), ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    expect(votes[0].trackId).toBe("trk_glacier_letters");
  });

  it("scores noise below real audio", () => {
    const rnd = mulberry32(99);
    const noise = new Float32Array(ANALYSIS_RATE * 5);
    for (let i = 0; i < noise.length; i++) noise[i] = (rnd() * 2 - 1) * 0.2;
    const query = fingerprintSamples(noise, ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    const best = votes[0]?.votes ?? 0;
    expect(best).toBeLessThan(15);
  });

  it("returns no votes for an empty query", () => {
    expect(matchHashes(new Map(), index)).toEqual([]);
  });

  it("orders votes by strength", () => {
    const query = fingerprintSamples(excerpt("trk_neon_overpass", 2, 6), ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    for (let i = 1; i < votes.length; i++) expect(votes[i - 1].votes).toBeGreaterThanOrEqual(votes[i].votes);
  });

  it("is robust to added noise", () => {
    const noisy = addNoise(excerpt("trk_neon_overpass", 6, 6), 0.05);
    const query = fingerprintSamples(noisy, ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    expect(votes[0].trackId).toBe("trk_neon_overpass");
  });

  it("is robust to gain changes", () => {
    const quiet = excerpt("trk_glacier_letters", 4, 6).map((v) => v * 0.15);
    const query = fingerprintSamples(Float32Array.from(quiet), ANALYSIS_RATE);
    const votes = matchHashes(query.hashes, index);
    expect(votes[0]?.trackId).toBe("trk_glacier_letters");
  });
});

describe("confidence", () => {
  it("is zero with no votes", () => {
    expect(confidenceFromVotes([]).confidence).toBe(0);
    expect(confidenceFromVotes([]).best).toBeNull();
  });
  it("increases with vote count", () => {
    const low = confidenceFromVotes([{ trackId: "a", offset: 0, votes: 3 }]).confidence;
    const high = confidenceFromVotes([{ trackId: "a", offset: 0, votes: 60 }]).confidence;
    expect(high).toBeGreaterThan(low);
  });
  it("rewards a clear margin", () => {
    const clear = confidenceFromVotes([
      { trackId: "a", offset: 0, votes: 40 },
      { trackId: "b", offset: 0, votes: 2 },
    ]).confidence;
    const tied = confidenceFromVotes([
      { trackId: "a", offset: 0, votes: 40 },
      { trackId: "b", offset: 0, votes: 40 },
    ]).confidence;
    expect(clear).toBeGreaterThan(tied);
  });
  it("never exceeds 1", () => {
    expect(confidenceFromVotes([{ trackId: "a", offset: 0, votes: 100000 }]).confidence).toBeLessThanOrEqual(1);
  });
});

describe("per-track fingerprint stability", () => {
  for (const track of TRACKS) {
    it(`${track.id}: produces a dense fingerprint`, () => {
      const samples = renderRange(track.spec, 0, 8 * ANALYSIS_RATE, ANALYSIS_RATE);
      const fp = fingerprintSamples(samples, ANALYSIS_RATE);
      expect(fp.hashes.size).toBeGreaterThan(300);
      expect(fp.peakCount).toBeGreaterThan(150);
    });
    it(`${track.id}: identical clips produce identical hashes`, () => {
      const a = fingerprintSamples(renderRange(track.spec, 20000, 20000, ANALYSIS_RATE), ANALYSIS_RATE);
      const b = fingerprintSamples(renderRange(track.spec, 20000, 20000, ANALYSIS_RATE), ANALYSIS_RATE);
      expect(a.hashes.size).toBe(b.hashes.size);
      expect([...a.hashes.keys()].sort()).toEqual([...b.hashes.keys()].sort());
    });
    it(`${track.id}: clips from different positions differ`, () => {
      const a = fingerprintSamples(renderRange(track.spec, 0, 16000, ANALYSIS_RATE), ANALYSIS_RATE);
      const b = fingerprintSamples(renderRange(track.spec, 400000, 16000, ANALYSIS_RATE), ANALYSIS_RATE);
      const overlap = [...a.hashes.keys()].filter((h) => b.hashes.has(h)).length;
      expect(overlap / Math.max(1, a.hashes.size)).toBeLessThan(0.75);
    });
    it(`${track.id}: full track duration is reported`, () => {
      const samples = renderRange(track.spec, 0, trackSampleCount(track.spec, ANALYSIS_RATE), ANALYSIS_RATE);
      const fp = fingerprintSamples(samples, ANALYSIS_RATE);
      expect(fp.durationSec).toBeCloseTo(track.duration, 0);
    });
  }
});
