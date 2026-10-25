// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportMp4, mp4Support, type Mp4TrackInfo } from "@/lib/client/mp4-export";
import { VIDEO_QUALITIES, VIDEO_BY_ID } from "@/lib/audio/quality";

/**
 * The MP4 export runs on the user's GPU through WebCodecs, which neither Node nor
 * jsdom ships. These tests swap in a faithful *shape* of the WebCodecs API —
 * VideoEncoder/AudioEncoder emit real EncodedVideoChunk/EncodedAudioChunk
 * objects, so `mp4-muxer` runs for real — and assert the orchestration around it:
 * frame counts, timestamps, encoder configuration, progress and cancellation.
 *
 * What this cannot prove is that a browser will accept our H.264/AAC configs;
 * that is `mp4Support()`'s job at runtime, and it is reported to the user.
 */

const TRACK: Mp4TrackInfo = {
  title: "Ishq Nagari",
  nativeTitle: "इश्क़ नगरी",
  artist: "Zoya Qureshi",
  album: "SongHub Sessions",
  palette: ["#ff7a59", "#2b1b4d"],
  bpm: 92,
  energy: 0.6,
  durationSec: 0.2,
  badge: "SongHub · 720p",
};

const SAMPLE_RATE = 48000;
const DURATION = 0.2;

/** Look up a video rung by id (the ladder is generated, so ids are typed loosely). */
function rung(id: string) {
  return VIDEO_BY_ID.get(id as Parameters<typeof VIDEO_BY_ID.get>[0]);
}

/* ------------------------------------------------------------- WebCodecs ---- */

interface ChunkInit {
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

class FakeEncodedChunk {
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  private readonly data: Uint8Array;
  constructor(init: ChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.data = init.data;
    this.byteLength = init.data.byteLength;
  }
  copyTo(destination: Uint8Array | ArrayBuffer): void {
    destination instanceof Uint8Array
      ? destination.set(this.data)
      : new Uint8Array(destination).set(this.data);
  }
}

const videoChunks: FakeEncodedChunk[] = [];
const audioChunks: FakeEncodedChunk[] = [];
const videoConfigs: Record<string, unknown>[] = [];
const audioConfigs: Record<string, unknown>[] = [];
const frameSizes: { width: number; height: number }[] = [];

class FakeVideoEncoder {
  static isConfigSupported = async (config: Record<string, unknown>) => ({ supported: true, config });
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  encodeQueueSize = 0;
  protected readonly output: (chunk: FakeEncodedChunk, meta: unknown) => void;
  constructor(init: { output: (chunk: FakeEncodedChunk, meta: unknown) => void }) {
    this.output = init.output;
  }
  protected emit(chunk: FakeEncodedChunk, meta: unknown) {
    this.output(chunk, meta);
  }
  configure(config: Record<string, unknown>) {
    videoConfigs.push(config);
    this.state = "configured";
  }
  encode(frame: { timestamp: number; duration: number }, options?: { keyFrame?: boolean }) {
    const chunk = new FakeEncodedChunk({
      type: options?.keyFrame ? "key" : "delta",
      timestamp: frame.timestamp,
      duration: frame.duration,
      data: new Uint8Array(16),
    });
    videoChunks.push(chunk);
    this.output(chunk, {
      decoderConfig: {
        codec: videoConfigs[0]?.codec,
        codedWidth: videoConfigs[0]?.width,
        codedHeight: videoConfigs[0]?.height,
        description: new Uint8Array([1, 100, 0, 31, 255]),
      },
    });
  }
  async flush() {}
  close() {
    this.state = "closed";
  }
}

class FakeAudioEncoder extends FakeVideoEncoder {
  configure(config: Record<string, unknown>) {
    audioConfigs.push(config);
    this.state = "configured";
  }
  encode(data: { timestamp: number; duration: number; numberOfFrames: number }) {
    const chunk = new FakeEncodedChunk({
      type: "key",
      timestamp: data.timestamp,
      duration: data.duration,
      data: new Uint8Array(8),
    });
    audioChunks.push(chunk);
    this.emit(chunk, {
      decoderConfig: {
        codec: "mp4a.40.2",
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
        description: new Uint8Array([18, 16]),
      },
    });
  }
}

class FakeVideoFrame {
  readonly timestamp: number;
  readonly duration: number;
  constructor(source: unknown, init: { timestamp: number; duration: number }) {
    const canvas = source as { width: number; height: number };
    frameSizes.push({ width: canvas.width, height: canvas.height });
    this.timestamp = init.timestamp;
    this.duration = init.duration;
  }
  close() {}
}

class FakeAudioData {
  readonly timestamp: number;
  readonly numberOfFrames: number;
  readonly duration: number;
  constructor(init: { timestamp: number; numberOfFrames: number; sampleRate: number }) {
    this.timestamp = init.timestamp;
    this.numberOfFrames = init.numberOfFrames;
    this.duration = Math.round((init.numberOfFrames / init.sampleRate) * 1_000_000);
  }
  close() {}
}

class FakeAudioContext {
  async decodeAudioData() {
    const samples = new Float32Array(Math.round(SAMPLE_RATE * DURATION));
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 440) * 0.4;
    return {
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: SAMPLE_RATE,
      duration: DURATION,
      getChannelData: () => samples,
    };
  }
  async close() {}
}

/* ------------------------------------------------------------------ canvas --- */

function fakeContext() {
  const gradient = { addColorStop: () => undefined };
  return {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: "",
    beginPath: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    rect: () => undefined,
    roundRect: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: (text: string) => ({ width: text.length * 20 }),
  } as unknown as CanvasRenderingContext2D;
}

const globals: Record<string, unknown> = {};
function installWebCodecs() {
  const bag: Record<string, unknown> = {
    VideoEncoder: FakeVideoEncoder,
    AudioEncoder: FakeAudioEncoder,
    VideoFrame: FakeVideoFrame,
    AudioData: FakeAudioData,
    EncodedVideoChunk: FakeEncodedChunk,
    EncodedAudioChunk: FakeEncodedChunk,
    AudioContext: FakeAudioContext,
  };
  for (const [key, value] of Object.entries(bag)) {
    globals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

function removeWebCodecs() {
  for (const key of Object.keys(globals)) delete (globalThis as Record<string, unknown>)[key];
}

beforeEach(() => {
  videoChunks.length = 0;
  audioChunks.length = 0;
  videoConfigs.length = 0;
  audioConfigs.length = 0;
  frameSizes.length = 0;
  installWebCodecs();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(1024), { status: 200, headers: { "content-type": "audio/wav" } })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext() as never);
});

afterEach(() => {
  removeWebCodecs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------- tests --- */

describe("mp4Support", () => {
  it("reports the H.264 profile a browser will accept", async () => {
    const support = await mp4Support(rung("720p")!);
    expect(support.supported).toBe(true);
    expect(support.codec).toMatch(/^avc1\./);
  });

  it("explains itself when the browser has no WebCodecs", async () => {
    removeWebCodecs();
    const support = await mp4Support(rung("1080p")!);
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/WebCodecs/);
  });

  it("asks for nothing heavier than the requested resolution", async () => {
    const spy = vi.spyOn(FakeVideoEncoder, "isConfigSupported");
    await mp4Support(rung("4k")!);
    const asked = spy.mock.calls.map(([config]) => config as { width: number; height: number });
    expect(asked.length).toBeGreaterThan(0);
    for (const config of asked) {
      expect(config.width).toBe(3840);
      expect(config.height).toBe(2160);
    }
  });
});

describe("exportMp4", () => {
  it("writes an MP4 container with one video chunk per frame", async () => {
    const quality = rung("240p")!;
    const blob = await exportMp4({ audioUrl: "/api/stream/x?q=mp3-128", track: TRACK, video: quality, audioKbps: 96, seconds: DURATION });

    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBeGreaterThan(100);
    const head = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
    expect(head.slice(4, 8)).toBe("ftyp");

    // 0.2 s at 30 fps -> 6 frames, each drawn at the requested size
    expect(videoChunks.length).toBe(Math.floor(DURATION * quality.fps));
    expect(frameSizes.every((size) => size.width === quality.width && size.height === quality.height)).toBe(true);

    // timestamps are microseconds, monotonically increasing
    const stamps = videoChunks.map((chunk) => chunk.timestamp);
    expect(stamps[0]).toBe(0);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
  });

  it("encodes the source audio alongside the video", async () => {
    const blob = await exportMp4({
      audioUrl: "/api/stream/x?q=mp3-320",
      track: TRACK,
      video: rung("240p")!,
      audioKbps: 128,
      seconds: DURATION,
    });
    expect(blob.size).toBeGreaterThan(0);
    expect(audioChunks.length).toBeGreaterThan(0);
    const config = audioConfigs[0] as { sampleRate: number; numberOfChannels: number; codec: string };
    expect(config.sampleRate).toBe(SAMPLE_RATE);
    expect(config.numberOfChannels).toBe(1);
    expect(config.codec).toBe("mp4a.40.2");
    // 0.2 s of mono audio is muxed into the file
    const last = audioChunks[audioChunks.length - 1];
    expect(last.timestamp).toBeGreaterThanOrEqual(0);
    expect(last.timestamp + last.duration).toBeLessThanOrEqual(Math.round(DURATION * 1_000_000) + 20_000);
  });

  it("configures the video encoder with the rung's bitrate and codec", async () => {
    const quality = rung("1080p")!;
    await exportMp4({ audioUrl: "/api/stream/x", track: TRACK, video: quality, audioKbps: 96, seconds: DURATION });
    const config = videoConfigs[0] as { codec: string; width: number; height: number; bitrate: number; framerate: number };
    expect(config.codec).toMatch(/^avc1\./);
    expect(config.width).toBe(quality.width);
    expect(config.height).toBe(quality.height);
    expect(config.bitrate).toBe(quality.videoKbps * 1000);
    expect(config.framerate).toBe(quality.fps);
  });

  it("reports progress from decoding through muxing", async () => {
    const phases: string[] = [];
    let lastRatio = 0;
    await exportMp4({
      audioUrl: "/api/stream/x",
      track: TRACK,
      video: rung("240p")!,
      audioKbps: 96,
      seconds: DURATION,
      onProgress: ({ phase, ratio }) => {
        phases.push(phase);
        expect(ratio).toBeGreaterThanOrEqual(lastRatio);
        lastRatio = ratio;
      },
    });
    expect(phases[0]).toBe("audio");
    expect(phases).toContain("video");
    expect(phases[phases.length - 1]).toBe("mux");
    expect(lastRatio).toBe(1);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    await expect(
      exportMp4({
        audioUrl: "/api/stream/x",
        track: TRACK,
        video: rung("240p")!,
        audioKbps: 96,
        seconds: DURATION,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it("refuses honestly when WebCodecs is missing", async () => {
    removeWebCodecs();
    await expect(
      exportMp4({ audioUrl: "/api/stream/x", track: TRACK, video: rung("720p")!, audioKbps: 96, seconds: DURATION }),
    ).rejects.toThrow(/WebCodecs/);
  });

  it("covers every rung of the video ladder", () => {
    // the UI offers 240p through 8K; each must be a real target
    expect(VIDEO_QUALITIES.length).toBeGreaterThanOrEqual(6);
    expect(VIDEO_QUALITIES[0].height).toBeLessThanOrEqual(360);
    expect(Math.max(...VIDEO_QUALITIES.map((q) => q.height))).toBeGreaterThanOrEqual(4320);
  });
});
