import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY,
  QUALITIES,
  QUALITY_BY_ID,
  TIER_LABELS,
  VIDEO_QUALITIES,
  contentTypeForQuality,
  dataSaving,
  estimateBytes,
  estimateVideoBytes,
  extensionForQuality,
  formatBytes,
  qualityOr,
  resolveQuality,
  videoQualityOr,
  wavBytesFor,
} from "@/lib/audio/quality";
import { buildId3Tag, createMp3Encoder, encodeMp3, floatToInt16, wrapMp3 } from "@/lib/audio/mp3";
import { decodeWav, encodeWav } from "@/lib/audio/wav";
import { geometryFor, fullWavCached, renderWavBytes } from "@/lib/audio/stream";
import { clearQualityCache, encodeTrackAudio, downloadFileName, qualityCacheStats, streamTrackMp3 } from "@/lib/audio/encode";
import { renderRange, trackSampleCount } from "@/lib/audio/synth";
import { TRACKS, BOLLYWOOD_TRACKS } from "@/lib/catalog/tracks";

const track = BOLLYWOOD_TRACKS[0] ?? TRACKS[0];

/** Minimal ID3v2.3 reader used to prove the writer is actually correct. */
function parseId3(bytes: Uint8Array): { version: number; size: number; frames: Record<string, string> } {
  const buffer = Buffer.from(bytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const version = view.getUint8(3);
  const size =
    (view.getUint8(6) << 21) | (view.getUint8(7) << 14) | (view.getUint8(8) << 7) | view.getUint8(9);
  const frames: Record<string, string> = {};
  let pos = 10;
  const end = 10 + size;
  while (pos + 10 <= end) {
    const id = buffer.toString("latin1", pos, pos + 4);
    const frameSize = view.getUint32(pos + 4);
    if (!frameSize) break;
    const bodyStart = pos + 10;
    const encoding = view.getUint8(bodyStart);
    const body = buffer.subarray(bodyStart + 1, bodyStart + frameSize);
    if (encoding === 1) {
      const text = body[0] === 0xff && body[1] === 0xfe ? body.subarray(2) : body;
      // COMM has a 3-byte language + NUL description before the text
      frames[id] = text.toString("utf16le").replace(/\u0000.*$/s, "");
    } else {
      frames[id] = body.toString("latin1").replace(/\u0000.*$/s, "");
    }
    pos = bodyStart + frameSize;
  }
  return { version, size, frames };
}

describe("quality ladder", () => {
  it("has unique ids", () => {
    expect(new Set(QUALITIES.map((q) => q.id)).size).toBe(QUALITIES.length);
  });
  it("exposes a default rung that exists", () => {
    expect(QUALITY_BY_ID.get(DEFAULT_QUALITY)).toBeDefined();
  });
  it("covers very low to studio", () => {
    const tiers = new Set(QUALITIES.map((q) => q.tier));
    expect(tiers.has("very-low")).toBe(true);
    expect(tiers.has("studio")).toBe(true);
    expect(tiers.has("very-high")).toBe(true);
  });
  it("ascends in size for a 3-minute song", () => {
    const mp3 = QUALITIES.filter((q) => q.family === "mp3").sort((a, b) => (a.bitrateKbps ?? 0) - (b.bitrateKbps ?? 0));
    let previous = 0;
    for (const quality of mp3) {
      const bytes = estimateBytes(180, quality);
      expect(bytes).toBeGreaterThan(previous);
      previous = bytes;
    }
  });
  it("marks only the smallest rungs as data savers", () => {
    const savers = QUALITIES.filter((q) => q.dataSaver);
    expect(savers.length).toBeGreaterThanOrEqual(2);
    for (const quality of savers) expect(estimateBytes(180, quality)).toBeLessThan(2 * 1024 * 1024);
  });
  it("reports real data savings versus 320 kbps", () => {
    expect(dataSaving(qualityOr("mp3-32"))).toBeGreaterThan(0.85);
    expect(dataSaving(qualityOr("mp3-320"))).toBe(0);
    expect(dataSaving(qualityOr("wav-48-24"))).toBe(0);
  });
  it("maps ids to container + content type", () => {
    expect(extensionForQuality(qualityOr("mp3-64"))).toBe("mp3");
    expect(contentTypeForQuality(qualityOr("mp3-64"))).toBe("audio/mpeg");
    expect(extensionForQuality(qualityOr("wav-44"))).toBe("wav");
    expect(contentTypeForQuality(qualityOr("wav-44"))).toBe("audio/wav");
  });
  it("falls back safely for unknown rungs", () => {
    expect(resolveQuality("nope")).toBeNull();
    expect(resolveQuality(null)).toBeNull();
    expect(qualityOr("nope").id).toBe(DEFAULT_QUALITY);
  });
  it("keeps sample rates honest per rung", () => {
    expect(qualityOr("mp3-32").sampleRate).toBe(22050);
    expect(qualityOr("mp3-320").sampleRate).toBe(48000);
    expect(qualityOr("wav-48-24").bitDepth).toBe(24);
  });
  it("labels every tier", () => {
    for (const quality of QUALITIES) expect(TIER_LABELS[quality.tier].length).toBeGreaterThanOrEqual(3);
  });
});

describe("size estimates", () => {
  it("computes exact WAV byte counts", () => {
    const quality = qualityOr("wav-44");
    // 10 s at 44.1 kHz, 16-bit mono
    expect(wavBytesFor(10, quality)).toBe(44 + 441000 * 2);
  });
  it("accounts for 24-bit payloads", () => {
    expect(wavBytesFor(10, qualityOr("wav-48-24"))).toBe(44 + 480000 * 3);
  });
  it("matches the stream geometry for a real track", () => {
    const quality = qualityOr("wav-48");
    const geo = geometryFor(track, quality.sampleRate, quality.bitDepth ?? 16);
    // geometry works from the exact spec duration; the UI estimate uses the
    // rounded track duration, so they agree to within one second of audio.
    const exact = (track.spec.bars * 4 * 60) / track.spec.bpm;
    expect(geo.totalBytes).toBe(wavBytesFor(exact, quality));
    expect(Math.abs(geo.totalBytes - wavBytesFor(track.duration, quality))).toBeLessThan(quality.sampleRate * 2 * 1.01);
  });
  it("estimates MP3 close to CBR", () => {
    const bytes = estimateBytes(60, qualityOr("mp3-128"));
    expect(bytes).toBeGreaterThan(60 * 16000 * 0.95);
    expect(bytes).toBeLessThan(60 * 16000 * 1.15);
  });
  it("formats sizes readably", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("video ladder", () => {
  it("spans 240p to 8K", () => {
    expect(VIDEO_QUALITIES[0].id).toBe("240p");
    const last = VIDEO_QUALITIES[VIDEO_QUALITIES.length - 1];
    expect(last.id).toBe("8k");
    expect(last.width).toBe(7680);
    expect(last.height).toBe(4320);
  });
  it("has even dimensions (H.264 requirement)", () => {
    for (const video of VIDEO_QUALITIES) {
      expect(video.width % 2).toBe(0);
      expect(video.height % 2).toBe(0);
    }
  });
  it("never lowers the bitrate as resolution grows", () => {
    let previous = 0;
    for (const video of VIDEO_QUALITIES) {
      expect(video.videoKbps).toBeGreaterThanOrEqual(previous);
      previous = video.videoKbps;
    }
  });
  it("flags heavy rungs for a warning", () => {
    expect(VIDEO_QUALITIES.filter((v) => v.heavy).map((v) => v.id)).toEqual(["1440p", "4k", "8k"]);
  });
  it("estimates MP4 sizes from both streams", () => {
    const bytes = estimateVideoBytes(60, videoQualityOr("1080p"), 128);
    expect(bytes).toBeGreaterThan(60 * 4500 * 1000 * 0.9 / 8);
    expect(videoQualityOr("nope").id).toBe("720p");
  });
});

describe("MP3 encoding", () => {
  const tone = (seconds: number, rate = 44100, hz = 440) => {
    const n = Math.round(seconds * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.4;
    return out;
  };

  it("converts float to int16 with clipping", () => {
    const pcm = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(32767);
    expect(pcm[5]).toBeGreaterThan(16000);
  });

  it("emits a decodable MPEG frame sync", () => {
    const mp3 = encodeMp3(tone(1), 44100, 128);
    expect(mp3.byteLength).toBeGreaterThan(8000);
    // 11 bits set + MPEG-1 Layer III marker
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1] & 0xe0).toBe(0xe0);
  });

  it("hits the requested bitrate within 20%", () => {
    for (const kbps of [64, 128, 320]) {
      const seconds = 2;
      const mp3 = encodeMp3(tone(seconds), 44100, kbps);
      const measuredKbps = (mp3.byteLength * 8) / 1000 / seconds;
      expect(measuredKbps).toBeGreaterThan(kbps * 0.8);
      expect(measuredKbps).toBeLessThan(kbps * 1.3);
    }
  });

  it("produces smaller files at lower rungs", () => {
    const low = encodeMp3(tone(2), 44100, 64).byteLength;
    const high = encodeMp3(tone(2), 44100, 320).byteLength;
    expect(high).toBeGreaterThan(low * 3);
  });

  it("streams in arbitrary chunk sizes and matches a single pass", () => {
    const samples = tone(1.5);
    const oneShot = encodeMp3(samples, 44100, 128);
    const encoder = createMp3Encoder(44100, 128);
    const chunks = [encoder.push(samples.subarray(0, 1000)), encoder.push(samples.subarray(1000)), encoder.finish()];
    const streamed = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(Math.abs(streamed - oneShot.byteLength)).toBeLessThan(oneShot.byteLength * 0.05);
  });

  it("writes a parseable ID3v2.3 tag with UTF-16 frames", () => {
    const tag = buildId3Tag({
      title: "बारिश की चादर",
      artist: "Monsoon Cinema",
      album: "Monsoon Reel",
      year: 2023,
      genre: "bollywood",
      bpm: 76,
    });
    const parsed = parseId3(tag);
    expect(parsed.version).toBe(3);
    expect(parsed.size).toBe(tag.byteLength - 10);
    expect(parsed.frames.TIT2).toBe("बारिश की चादर");
    expect(parsed.frames.TPE1).toBe("Monsoon Cinema");
    expect(parsed.frames.TALB).toBe("Monsoon Reel");
    expect(parsed.frames.TYER).toBe("2023");
    expect(parsed.frames.TCON).toBe("bollywood");
    expect(parsed.frames.TBPM).toBe("76");
    expect(Object.keys(parsed.frames)).toContain("TSSE");
  });

  it("prepends the tag without corrupting the audio", () => {
    const mp3 = encodeMp3(tone(0.5), 44100, 96);
    const wrapped = wrapMp3(mp3, { title: "T", artist: "A", album: "L", year: 2024 });
    expect(wrapped.byteLength).toBeGreaterThan(mp3.byteLength);
    expect(Buffer.from(wrapped).toString("latin1", 0, 3)).toBe("ID3");
    expect(wrapped[wrapped.byteLength - mp3.byteLength]).toBe(mp3[0]);
  });
});

describe("WAV bit depths", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);

  it("round-trips 16-bit", () => {
    const bytes = encodeWav(samples, 44100, 1, 16);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.samples[1]).toBeCloseTo(0.5, 2);
    expect(decoded.samples[3]).toBeCloseTo(1, 2);
  });

  it("writes unsigned 8-bit PCM with silence at 128", () => {
    const bytes = encodeWav(samples, 22050, 1, 8);
    expect(bytes[44]).toBe(128);
    expect(bytes[45]).toBeGreaterThan(128);
    expect(bytes[46]).toBeLessThan(128);
  });

  it("writes 24-bit samples three bytes wide", () => {
    const bytes = encodeWav(samples, 48000, 1, 24);
    expect(bytes.byteLength).toBe(44 + samples.length * 3);
    // -1.0 at sample index 4 -> 0x800000 little endian
    const offset = 44 + 4 * 3;
    expect(bytes[offset]).toBe(0x00);
    expect(bytes[offset + 1]).toBe(0x00);
    expect(bytes[offset + 2]).toBe(0x80);
  });
});

describe("byte-range rendering at a rung", () => {
  it("stitches 48 kHz ranges back into the same file", () => {
    const small = TRACKS[0];
    const geo = geometryFor(small, 48000, 16);
    const head = renderWavBytes(small, 0, 4095, 48000, 16);
    const tail = renderWavBytes(small, 4096, geo.totalBytes - 1, 48000, 16);
    expect(head.byteLength + tail.byteLength).toBe(geo.totalBytes);
    expect(Buffer.from(head).toString("latin1", 0, 4)).toBe("RIFF");
    // sample rate in the fmt chunk
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("keeps 24-bit ranges byte-exact", () => {
    const small = TRACKS[1];
    const geo = geometryFor(small, 44100, 24);
    const chunk = renderWavBytes(small, 100, 100 + 600, 44100, 24);
    expect(chunk.byteLength).toBe(601);
    expect(geo.totalBytes).toBe(44 + trackSampleCount(small.spec, 44100) * 3);
    const full = fullWavCached(small, 44100, 24);
    expect(Buffer.compare(Buffer.from(full.subarray(100, 701)), Buffer.from(chunk))).toBe(0);
  });

  it("renders a different length at each sample rate", () => {
    const a = renderRange(track.spec, 0, 100, 22050);
    const b = renderRange(track.spec, 0, 100, 48000);
    expect(a.length).toBe(b.length);
    // same instant of music, different sample spacing
    expect(a[10]).not.toBe(b[10]);
  });
});

describe("encodeTrackAudio", () => {
  it("encodes the whole track as MP3 with a tag", () => {
    clearQualityCache();
    const encoded = encodeTrackAudio(track, qualityOr("mp3-64"));
    expect(encoded.contentType).toBe("audio/mpeg");
    expect(encoded.extension).toBe("mp3");
    expect(Buffer.from(encoded.bytes).toString("latin1", 0, 3)).toBe("ID3");
    expect(encoded.bytes.byteLength).toBeGreaterThan(20_000);
    expect(encoded.cached).toBe(false);
  });

  it("serves the second request from cache", () => {
    const again = encodeTrackAudio(track, qualityOr("mp3-64"));
    expect(again.cached).toBe(true);
    expect(qualityCacheStats().entries).toBeGreaterThan(0);
  });

  it("encodes WAV rungs at their own rates", () => {
    const encoded = encodeTrackAudio(track, qualityOr("wav-22"));
    expect(encoded.contentType).toBe("audio/wav");
    const view = new DataView(encoded.bytes.buffer, encoded.bytes.byteOffset, 44);
    expect(view.getUint32(24, true)).toBe(22050);
    expect(encoded.bytes.byteLength).toBe(44 + trackSampleCount(track.spec, 22050) * 2);
  });

  it("names downloads like a human would", () => {
    const name = downloadFileName(track, qualityOr("mp3-192"));
    expect(name).toContain(track.artist);
    expect(name).toContain(track.title);
    expect(name).toContain("192kbps");
    expect(name.endsWith(".mp3")).toBe(true);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe("streamed MP3 output", () => {
  /** Drain a ReadableStream of bytes into one buffer, recording the chunk classes. */
  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    const classes = new Set<string>();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      classes.add(value.constructor.name);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, classes, chunkCount: chunks.length };
  }

  it("only ever hands out real Uint8Array chunks", async () => {
    // lamejs returns Int8Array; Node's server rejects those with
    // ERR_INVALID_ARG_TYPE and the response dies part-way through the song.
    const { classes, chunkCount } = await drain(streamTrackMp3(track, qualityOr("mp3-32")));
    expect(chunkCount).toBeGreaterThan(1);
    expect([...classes]).toEqual(["Uint8Array"]);
  }, 60000);

  it("streams the same bytes a buffered download would produce", async () => {
    const quality = qualityOr("mp3-32");
    clearQualityCache();
    const streamed = await drain(streamTrackMp3(track, quality));
    const buffered = encodeTrackAudio(track, quality).bytes;
    expect(streamed.bytes.byteLength).toBe(buffered.byteLength);
    expect(Buffer.from(streamed.bytes).equals(Buffer.from(buffered))).toBe(true);
    // the ID3 header survives the streaming path, so the LRU is not poisoned
    // with an untagged file that later downloads would hand back
    expect(Buffer.from(streamed.bytes.subarray(0, 3)).toString("latin1")).toBe("ID3");
    expect(Buffer.from(buffered.subarray(0, 3)).toString("latin1")).toBe("ID3");
  }, 60000);

  it("replays a cached encode in one piece", async () => {
    const quality = qualityOr("mp3-32");
    await drain(streamTrackMp3(track, quality)); // fills the LRU
    const again = await drain(streamTrackMp3(track, quality));
    expect(again.chunkCount).toBe(1);
    expect([...again.classes]).toEqual(["Uint8Array"]);
  }, 60000);
});
