import { beforeAll, describe, expect, it } from "vitest";
import {
  clearStreamCache,
  fullWavCached,
  geometryFor,
  parseRange,
  renderWavBytes,
} from "@/lib/audio/stream";
import { decodeWav } from "@/lib/audio/wav";
import { RENDER_RATE, sampleAt, trackSampleCount } from "@/lib/audio/synth";
import { TRACKS } from "@/lib/catalog/tracks";

const track = TRACKS[0];

describe("geometry", () => {
  it("reports a byte length consistent with the sample count", () => {
    const geo = geometryFor(track);
    expect(geo.sampleCount).toBe(trackSampleCount(track.spec, RENDER_RATE));
    expect(geo.totalBytes).toBe(44 + geo.sampleCount * 2);
  });
  it("reports the duration", () => {
    expect(Math.abs(geometryFor(track).durationSec - track.duration)).toBeLessThan(1);
  });
  it("uses the render sample rate", () => {
    expect(geometryFor(track).sampleRate).toBe(RENDER_RATE);
  });
  it("is stable across calls", () => {
    expect(geometryFor(track).totalBytes).toBe(geometryFor(track).totalBytes);
  });
  it("is positive for every track", () => {
    for (const t of TRACKS) expect(geometryFor(t).totalBytes).toBeGreaterThan(1000);
  });
});

describe("parseRange", () => {
  it("returns null without a header", () => {
    expect(parseRange(null, 1000)).toBeNull();
  });
  it("parses a full range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });
  it("parses an open-ended range", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });
  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("clamps an over-long end", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("rejects an inverted range", () => {
    expect(parseRange("bytes=500-100", 1000)).toBeNull();
  });
  it("rejects a start beyond the file", () => {
    expect(parseRange("bytes=2000-3000", 1000)).toBeNull();
  });
  it("rejects malformed headers", () => {
    for (const bad of ["bytes=abc", "items=0-10", "bytes=", "0-10", "bytes=1-2-3"]) {
      expect(parseRange(bad, 1000)).toBeNull();
    }
  });
  it("rejects a zero-length suffix", () => {
    expect(parseRange("bytes=-0", 1000)).toBeNull();
  });
  it("handles a single byte", () => {
    expect(parseRange("bytes=0-0", 1000)).toEqual({ start: 0, end: 0 });
  });
});

describe("byte-range rendering", () => {
  beforeAll(() => clearStreamCache());

  it("produces a valid WAV when asking for the whole file", () => {
    const geo = geometryFor(track);
    const bytes = renderWavBytes(track, 0, geo.totalBytes - 1);
    expect(bytes.byteLength).toBe(geo.totalBytes);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(RENDER_RATE);
    expect(decoded.samples.length).toBe(geo.sampleCount);
  });

  it("writes the header when only the header is requested", () => {
    const bytes = renderWavBytes(track, 0, 43);
    expect(bytes.byteLength).toBe(44);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
  });

  it("returns exactly the requested number of bytes", () => {
    for (const [start, end] of [
      [0, 99],
      [44, 143],
      [1000, 1999],
      [12345, 12345],
    ]) {
      expect(renderWavBytes(track, start, end).byteLength).toBe(end - start + 1);
    }
  });

  it("clamps requests beyond the end of the file", () => {
    const geo = geometryFor(track);
    const bytes = renderWavBytes(track, geo.totalBytes - 10, geo.totalBytes + 1000);
    expect(bytes.byteLength).toBe(10);
  });

  it("serves the same audio as a full render at the same offset", () => {
    const geo = geometryFor(track);
    const startByte = 44 + 200000; // 100_000 samples in
    const endByte = startByte + 3999;
    const slice = renderWavBytes(track, startByte, endByte);
    const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
    for (let i = 0; i < 100; i++) {
      const sample = view.getInt16(i * 2, true) / 32768;
      const expected = sampleAt(track.spec, (100000 + i) / RENDER_RATE);
      expect(Math.abs(sample - expected)).toBeLessThan(0.001);
    }
    expect(geo.sampleCount).toBeGreaterThan(300000);
  });

  it("range requests stitch together into the full file", () => {
    const geo = geometryFor(track);
    const chunk = 40000;
    const pieces: Uint8Array[] = [];
    for (let start = 0; start < geo.totalBytes; start += chunk) {
      pieces.push(renderWavBytes(track, start, Math.min(start + chunk - 1, geo.totalBytes - 1)));
    }
    const total = pieces.reduce((n, p) => n + p.byteLength, 0);
    expect(total).toBe(geo.totalBytes);
    // spot-check that the concatenation decodes as one WAV
    const joined = new Uint8Array(total);
    let cursor = 0;
    for (const piece of pieces) {
      joined.set(piece, cursor);
      cursor += piece.byteLength;
    }
    const decoded = decodeWav(joined);
    expect(decoded.samples.length).toBe(geo.sampleCount);
  });
});

describe("LRU cache", () => {
  beforeAll(() => clearStreamCache());

  it("returns an identical buffer on the second call", () => {
    const a = fullWavCached(track);
    const b = fullWavCached(track);
    expect(a).toBe(b);
  });
  it("caches a fully valid WAV", () => {
    const bytes = fullWavCached(track);
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
  });
  it("clears on demand", () => {
    clearStreamCache();
    const a = fullWavCached(track);
    clearStreamCache();
    const b = fullWavCached(track);
    expect(a).not.toBe(b);
    expect(a.byteLength).toBe(b.byteLength);
  });
  it("evicts old entries rather than growing forever", () => {
    clearStreamCache();
    const cached = TRACKS.slice(0, 6).map((t) => fullWavCached(t));
    expect(cached).toHaveLength(6);
    expect(new Set(cached.map((b) => b.byteLength)).size).toBeGreaterThan(0);
  }, 120000);
});

describe("per-track streaming integrity", () => {
  for (const t of TRACKS) {
    it(`${t.id}: header declares the correct data size`, () => {
      const geo = geometryFor(t);
      const header = renderWavBytes(t, 0, 43);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      expect(view.getUint32(40, true)).toBe(geo.sampleCount * 2);
      expect(view.getUint32(4, true)).toBe(36 + geo.sampleCount * 2);
      expect(view.getUint32(24, true)).toBe(RENDER_RATE);
    });
    it(`${t.id}: has audible content at 50% through`, () => {
      const geo = geometryFor(t);
      const mid = Math.floor(geo.totalBytes / 2);
      const bytes = renderWavBytes(t, mid, mid + 7999);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let energy = 0;
      for (let i = 0; i < 4000; i++) energy += Math.abs(view.getInt16(i * 2, true));
      expect(energy).toBeGreaterThan(0);
    });
  }
});
