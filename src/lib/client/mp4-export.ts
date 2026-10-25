"use client";

/**
 * MP4 "video song" export, rendered on the user's device.
 *
 * There is no video file to download: the video is a *generated* visualiser for
 * a generated track. We render it with the browser's own encoders (WebCodecs)
 * and mux it with `mp4-muxer`:
 *
 *   /api/stream/<id>?q=…  ──► decodeAudioData ──► mono PCM
 *                                                   │
 *   canvas frame ──► VideoEncoder (H.264, 240p…8K) ──┤
 *                                     AAC audio ────┴──► MP4 (fastStart) ──► Blob
 *
 * Why client-side? H.264 at 4K/8K is the expensive part, and the machine with
 * the GPU is the one in front of the user. The server only ever serves audio.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { VideoQuality } from "@/lib/audio/quality";

export interface Mp4TrackInfo {
  title: string;
  nativeTitle?: string;
  artist: string;
  album?: string;
  palette: [string, string];
  bpm: number;
  energy: number;
  durationSec: number;
  /** Watermark line, e.g. "SongHub · 1080p · MP3 128 kbps source". */
  badge?: string;
}

export interface Mp4ExportOptions {
  audioUrl: string;
  track: Mp4TrackInfo;
  video: VideoQuality;
  /** AAC bitrate for the audio track, in kbps. */
  audioKbps: number;
  /** How many seconds to export (defaults to the whole song). */
  seconds?: number;
  onProgress?: (progress: { phase: "audio" | "video" | "mux"; ratio: number; detail?: string }) => void;
  signal?: AbortSignal;
}

export interface Mp4Support {
  supported: boolean;
  reason?: string;
  /** Codec string that will be used, when supported. */
  codec?: string;
}

/** Candidate H.264 profiles ordered by "most likely to be supported". */
function codecCandidates(video: VideoQuality): string[] {
  const { height } = video;
  if (height <= 480) return ["avc1.42001f", "avc1.42e01f", "avc1.4d401f"]; // Baseline 3.1
  if (height <= 720) return ["avc1.42001f", "avc1.4d401f", "avc1.64001f"]; // Level 3.1/4.0
  if (height <= 1080) return ["avc1.420028", "avc1.4d4028", "avc1.640028"]; // Level 4.0
  if (height <= 1440) return ["avc1.42002a", "avc1.4d402a", "avc1.64002a"]; // Level 4.2
  if (height <= 2160) return ["avc1.640033", "avc1.4d4033", "avc1.420033"]; // Level 5.1
  return ["avc1.64003c", "avc1.640040", "avc1.4d403c"]; // Level 6.0+ for 8K
}

export async function mp4Support(video?: VideoQuality): Promise<Mp4Support> {
  if (typeof window === "undefined") return { supported: false, reason: "Server side — export runs in the browser." };
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return {
      supported: false,
      reason: "This browser has no WebCodecs video encoder. Chrome/Edge 94+ or Safari 16.4+ can create MP4s.",
    };
  }
  if (typeof VideoFrame === "undefined" || typeof AudioData === "undefined") {
    return { supported: false, reason: "WebCodecs is only partly available in this browser." };
  }
  const probe = video ?? { id: "720p", label: "720p", width: 1280, height: 720, fps: 30, videoKbps: 2500, heavy: false, note: "" };
  for (const codec of codecCandidates(probe)) {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec,
        width: probe.width,
        height: probe.height,
        bitrate: probe.videoKbps * 1000,
        framerate: probe.fps,
      });
      if (result.supported) return { supported: true, codec };
    } catch {
      /* try the next profile */
    }
  }
  return { supported: false, reason: "No H.264 profile in this browser accepts that resolution." };
}

function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function decodeAudio(url: string, signal?: AbortSignal): Promise<{ samples: Float32Array; sampleRate: number }> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load the audio source (${response.status}).`);
  const bytes = await response.arrayBuffer();
  const Ctor: typeof AudioContext | undefined =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("This browser cannot decode audio (no AudioContext).");
  const ctx = new Ctor();
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return { samples: mono, sampleRate: buffer.sampleRate };
  } finally {
    void ctx.close();
  }
}

/** Coarse loudness envelope used to make the visualiser react to the music. */
function buildPeaks(samples: Float32Array, buckets = 2400): Float32Array {
  const peaks = new Float32Array(buckets);
  const step = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const start = b * step;
    const end = Math.min(samples.length, start + step);
    for (let i = start; i < end; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    peaks[b] = peak;
  }
  return peaks;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", { alpha: false }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Could not create a 2D canvas context for the video.");
  return ctx;
}

interface DrawState {
  peaks: Float32Array;
  track: Mp4TrackInfo;
  width: number;
  height: number;
  accent: string;
  accent2: string;
}

/** One frame of the "video song": gradient card, waveform, titles, progress. */
function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  state: DrawState,
  timeSec: number,
  durationSec: number,
) {
  const { width: w, height: h, track, peaks, accent, accent2 } = state;
  const scale = h / 1080;
  const progress = durationSec > 0 ? Math.min(1, timeSec / durationSec) : 0;
  const beatSec = 60 / Math.max(40, track.bpm);
  const beatPhase = (timeSec % beatSec) / beatSec;
  const pulse = Math.exp(-beatPhase * 4.2) * (0.45 + 0.55 * track.energy);
  const peakIndex = Math.min(peaks.length - 1, Math.floor(progress * (peaks.length - 1)));
  const level = 0.25 + 0.75 * (peaks[peakIndex] ?? 0);

  // background
  ctx.fillStyle = "#06070a";
  ctx.fillRect(0, 0, w, h);

  const drift = Math.sin(timeSec * 0.21) * 0.5 + 0.5;
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, accent);
  gradient.addColorStop(0.55 + drift * 0.1, accent2);
  gradient.addColorStop(1, "#06070a");
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  // beat-reactive glow
  const glow = ctx.createRadialGradient(
    w * (0.5 + 0.08 * Math.sin(timeSec * 0.6)),
    h * (0.42 + 0.05 * Math.cos(timeSec * 0.5)),
    0,
    w * 0.5,
    h * 0.45,
    Math.max(w, h) * (0.55 + 0.1 * pulse),
  );
  glow.addColorStop(0, `${accent}cc`);
  glow.addColorStop(1, "#06070a00");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // waveform ring of bars
  const bars = 72;
  const barWidth = (w * 0.72) / bars;
  const baseY = h * 0.66;
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < bars; i++) {
    const index = Math.min(peaks.length - 1, Math.floor(((progress * 0.8 + i / bars * 0.2) % 1) * (peaks.length - 1)));
    const amplitude = (peaks[index] ?? 0) * level;
    const barHeight = Math.max(barWidth * 0.6, amplitude * h * (0.1 + 0.16 * pulse));
    const x = w * 0.14 + i * barWidth;
    const g = ctx.createLinearGradient(0, baseY - barHeight, 0, baseY + barHeight);
    g.addColorStop(0, "#ffffffdd");
    g.addColorStop(0.5, accent);
    g.addColorStop(1, `${accent2}aa`);
    ctx.fillStyle = g;
    ctx.beginPath();
    const radius = Math.min(barWidth * 0.35, barHeight);
    ctx.roundRect?.(x, baseY - barHeight, barWidth * 0.62, barHeight * 2, radius);
    if (!ctx.roundRect) ctx.rect(x, baseY - barHeight, barWidth * 0.62, barHeight * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // title block
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(76 * scale)}px "Inter", "Segoe UI", system-ui, -apple-system, "Noto Sans Devanagari", sans-serif`;
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 24 * scale;
  ctx.fillText(truncate(ctx, track.title, w * 0.86), w * 0.09, h * 0.3);

  if (track.nativeTitle) {
    ctx.font = `600 ${Math.round(54 * scale)}px "Noto Sans Devanagari", "Nirmala UI", system-ui, sans-serif`;
    ctx.fillStyle = "#ffffffdd";
    ctx.fillText(truncate(ctx, track.nativeTitle, w * 0.86), w * 0.09, h * 0.3 + 74 * scale);
  }

  ctx.font = `500 ${Math.round(40 * scale)}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#ffffffcc";
  const subtitle = track.album ? `${track.artist} · ${track.album}` : track.artist;
  ctx.fillText(truncate(ctx, subtitle, w * 0.86), w * 0.09, h * 0.3 + (track.nativeTitle ? 148 : 74) * scale);

  // progress bar + timecode
  const barY = h * 0.82;
  const barW = w * 0.82;
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.roundRect?.(w * 0.09, barY, barW, 8 * scale, 8 * scale);
  if (!ctx.roundRect) ctx.rect(w * 0.09, barY, barW, 8 * scale);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect?.(w * 0.09, barY, Math.max(8 * scale, barW * progress), 8 * scale, 8 * scale);
  if (!ctx.roundRect) ctx.rect(w * 0.09, barY, barW * progress, 8 * scale);
  ctx.fill();

  ctx.font = `500 ${Math.round(30 * scale)}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#ffffff99";
  ctx.fillText(formatClock(timeSec), w * 0.09, barY + 56 * scale);
  ctx.textAlign = "right";
  ctx.fillText(formatClock(durationSec), w * 0.91, barY + 56 * scale);
  ctx.textAlign = "left";

  // badge
  if (track.badge) {
    ctx.globalAlpha = 0.9;
    ctx.font = `600 ${Math.round(26 * scale)}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    const text = track.badge;
    const metrics = ctx.measureText(text);
    const padX = 22 * scale;
    const boxW = metrics.width + padX * 2;
    const boxH = 52 * scale;
    ctx.beginPath();
    ctx.roundRect?.(w * 0.09, h * 0.09, boxW, boxH, boxH / 2);
    if (!ctx.roundRect) ctx.rect(w * 0.09, h * 0.09, boxW, boxH);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, w * 0.09 + padX, h * 0.09 + boxH * 0.66);
    ctx.globalAlpha = 1;
  }
}

function truncate(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 3 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Encode the visualiser + audio into a playable MP4. */
export async function exportMp4(options: Mp4ExportOptions): Promise<Blob> {
  const { audioUrl, track, video, audioKbps, signal } = options;
  const support = await mp4Support(video);
  if (!support.supported) throw new Error(support.reason ?? "MP4 export is not available in this browser.");
  const codec = support.codec!;

  options.onProgress?.({ phase: "audio", ratio: 0.02, detail: "Decoding the audio…" });
  const decoded = await decodeAudio(audioUrl, signal);
  const totalSeconds = Math.min(
    options.seconds ?? track.durationSec ?? decoded.samples.length / decoded.sampleRate,
    decoded.samples.length / decoded.sampleRate,
  );
  const frames = Math.max(1, Math.floor(totalSeconds * video.fps));
  if (signal?.aborted) throw new Error("Export cancelled.");

  const peaks = buildPeaks(decoded.samples.subarray(0, Math.floor(totalSeconds * decoded.sampleRate)));
  const canvas = createCanvas(video.width, video.height);
  const ctx = context2d(canvas);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: video.width, height: video.height, frameRate: video.fps },
    audio: { codec: "aac", sampleRate: decoded.sampleRate, numberOfChannels: 1 },
    fastStart: "in-memory",
  });

  let failure: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });
  videoEncoder.configure({
    codec,
    width: video.width,
    height: video.height,
    bitrate: video.videoKbps * 1000,
    framerate: video.fps,
    latencyMode: "quality",
  });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });
  audioEncoder.configure({
    codec: "mp4a.40.2",
    sampleRate: decoded.sampleRate,
    numberOfChannels: 1,
    bitrate: audioKbps * 1000,
  });

  try {
    const state: DrawState = {
      peaks,
      track,
      width: video.width,
      height: video.height,
      accent: track.palette[0],
      accent2: track.palette[1],
    };

    let audioCursor = 0;
    const totalAudioFrames = Math.floor(totalSeconds * decoded.sampleRate);
    const audioBlock = 4800; // 100 ms at 48 kHz

    const pushAudioUntil = (untilSec: number) => {
      while (audioCursor < totalAudioFrames) {
        const startSec = audioCursor / decoded.sampleRate;
        if (startSec > untilSec) break;
        const count = Math.min(audioBlock, totalAudioFrames - audioCursor);
        const chunk = decoded.samples.slice(audioCursor, audioCursor + count);
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate: decoded.sampleRate,
          numberOfFrames: count,
          numberOfChannels: 1,
          timestamp: Math.round(startSec * 1_000_000),
          data: chunk,
        });
        audioEncoder.encode(audioData);
        audioData.close();
        audioCursor += count;
      }
    };

    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new Error("Export cancelled.");
      if (failure) throw failure;
      const timeSec = i / video.fps;
      drawFrame(ctx, state, timeSec, totalSeconds);
      pushAudioUntil(timeSec);

      const frame = new VideoFrame(canvas as unknown as CanvasImageSource, {
        timestamp: Math.round(timeSec * 1_000_000),
        duration: Math.round(1_000_000 / video.fps),
      });
      videoEncoder.encode(frame, { keyFrame: i % (video.fps * 2) === 0 });
      frame.close();

      if (videoEncoder.encodeQueueSize > 6) await sleep(4);
      if (i % 5 === 0) {
        options.onProgress?.({
          phase: "video",
          ratio: 0.1 + (i / frames) * 0.85,
          detail: `Rendering ${video.width}×${video.height} · frame ${i + 1}/${frames}`,
        });
        await sleep(0);
      }
    }

    pushAudioUntil(totalSeconds + 1);
    options.onProgress?.({ phase: "mux", ratio: 0.96, detail: "Writing the MP4 container…" });
    await audioEncoder.flush();
    await videoEncoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    const buffer = (muxer.target as ArrayBufferTarget).buffer;
    options.onProgress?.({ phase: "mux", ratio: 1, detail: "Done." });
    return new Blob([buffer], { type: "video/mp4" });
  } finally {
    try {
      if (videoEncoder.state !== "closed") videoEncoder.close();
    } catch {
      /* already closed */
    }
    try {
      if (audioEncoder.state !== "closed") audioEncoder.close();
    } catch {
      /* already closed */
    }
  }
}

/** Save a blob through a temporary anchor click. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
