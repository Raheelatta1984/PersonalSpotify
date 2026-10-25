/**
 * Playback / download quality ladder.
 *
 * Every track in SongHub is synthesised from a `TrackSpec`, which means a
 * "quality" is not a re-encode of a master file — it is a *different render*:
 *
 *   • sample rate   8 kHz … 48 kHz   (the synth is a pure function of time, so
 *                                   44.1 kHz really is 44.1 kHz, not upsampled)
 *   • codec         MP3 (LAME) or WAV (PCM 8/16/24-bit)
 *   • bitrate       32 kbps … 320 kbps for MP3
 *
 * The ladder therefore spans "barely-there data saver" to "lossless studio",
 * and the player can switch between rungs without a page reload. Everything in
 * this module is pure data so the client can show labels and size estimates
 * without importing any Node code.
 */

export type QualityFamily = "mp3" | "wav";
export type QualityTier = "very-low" | "low" | "standard" | "high" | "very-high" | "studio";

export interface AudioQuality {
  /** Stable id used in URLs: `/api/stream/<id>?q=<id>`. */
  id: string;
  family: QualityFamily;
  tier: QualityTier;
  /** Human label for menus. */
  label: string;
  /** Compact label for the player bar. */
  short: string;
  /** Sample rate the synth renders at for this rung. */
  sampleRate: number;
  channels: 1;
  /** MP3 target bitrate. */
  bitrateKbps?: number;
  /** WAV bits per sample. */
  bitDepth?: 8 | 16 | 24;
  /** Bytes of audio per second, used for file-size estimates. */
  bytesPerSecond: number;
  /** True for the rungs we recommend on metered connections. */
  dataSaver: boolean;
  /** One line explaining the trade-off. */
  note: string;
}

export const TIER_LABELS: Record<QualityTier, string> = {
  "very-low": "very low · data saver",
  low: "low",
  standard: "standard",
  high: "high",
  "very-high": "very high",
  studio: "studio / lossless",
};

/** MP3 rungs, low → high. */
const MP3: AudioQuality[] = [
  {
    id: "mp3-32",
    family: "mp3",
    tier: "very-low",
    label: "MP3 · 32 kbps",
    short: "32k MP3",
    sampleRate: 22050,
    channels: 1,
    bitrateKbps: 32,
    bytesPerSecond: 4000,
    dataSaver: true,
    note: "Smallest files — about 0.4 MB for a 90-second song. Fine on a weak 3G signal or a prepaid data cap.",
  },
  {
    id: "mp3-64",
    family: "mp3",
    tier: "low",
    label: "MP3 · 64 kbps",
    short: "64k MP3",
    sampleRate: 32000,
    channels: 1,
    bitrateKbps: 64,
    bytesPerSecond: 8000,
    dataSaver: true,
    note: "Data-saver sweet spot: roughly 0.7 MB per song and still clear on phone speakers.",
  },
  {
    id: "mp3-96",
    family: "mp3",
    tier: "standard",
    label: "MP3 · 96 kbps",
    short: "96k MP3",
    sampleRate: 44100,
    channels: 1,
    bitrateKbps: 96,
    bytesPerSecond: 12000,
    dataSaver: false,
    note: "Full 44.1 kHz render at a modest bitrate — good balance for mobile listening.",
  },
  {
    id: "mp3-128",
    family: "mp3",
    tier: "standard",
    label: "MP3 · 128 kbps",
    short: "128k MP3",
    sampleRate: 44100,
    channels: 1,
    bitrateKbps: 128,
    bytesPerSecond: 16000,
    dataSaver: false,
    note: "The default: what most streaming services use on their standard tier.",
  },
  {
    id: "mp3-192",
    family: "mp3",
    tier: "high",
    label: "MP3 · 192 kbps",
    short: "192k MP3",
    sampleRate: 44100,
    channels: 1,
    bitrateKbps: 192,
    bytesPerSecond: 24000,
    dataSaver: false,
    note: "High quality — worth it on wired headphones and good speakers.",
  },
  {
    id: "mp3-320",
    family: "mp3",
    tier: "very-high",
    label: "MP3 · 320 kbps",
    short: "320k MP3",
    sampleRate: 48000,
    channels: 1,
    bitrateKbps: 320,
    bytesPerSecond: 40000,
    dataSaver: false,
    note: "The best MP3 you can get — near-transparent for synth material.",
  },
];

/** WAV rungs (PCM). Sizes are the honest cost of not compressing. */
const WAV: AudioQuality[] = [
  {
    id: "wav-22",
    family: "wav",
    tier: "standard",
    label: "WAV · 22.05 kHz 16-bit",
    short: "22k WAV",
    sampleRate: 22050,
    channels: 1,
    bitDepth: 16,
    bytesPerSecond: 44100,
    dataSaver: false,
    note: "Same rate as a CD's half-band — the classic lo-fi/chiptune recorder setting.",
  },
  {
    id: "wav-44",
    family: "wav",
    tier: "high",
    label: "WAV · 44.1 kHz 16-bit",
    short: "44.1k WAV",
    sampleRate: 44100,
    channels: 1,
    bitDepth: 16,
    bytesPerSecond: 88200,
    dataSaver: false,
    note: "CD-quality PCM — uncompressed and lossless for this synth.",
  },
  {
    id: "wav-48",
    family: "wav",
    tier: "studio",
    label: "WAV · 48 kHz 16-bit",
    short: "48k WAV",
    sampleRate: 48000,
    channels: 1,
    bitDepth: 16,
    bytesPerSecond: 96000,
    dataSaver: false,
    note: "Video-native sample rate — pair with an MP4 export.",
  },
  {
    id: "wav-48-24",
    family: "wav",
    tier: "studio",
    label: "WAV · 48 kHz 24-bit",
    short: "48k/24 WAV",
    sampleRate: 48000,
    channels: 1,
    bitDepth: 24,
    bytesPerSecond: 144000,
    dataSaver: false,
    note: "24-bit master render for editing — big files, no extra detail beyond the synth.",
  },
];

export const QUALITIES: AudioQuality[] = [...MP3, ...WAV];

export const QUALITY_BY_ID = new Map(QUALITIES.map((q) => [q.id, q]));

/** The default rung: what `/api/stream/<id>` serves with no `?q=`. */
export const DEFAULT_QUALITY = "mp3-128";

/** Fallback when a user's stored choice no longer exists. */
export function resolveQuality(id: string | null | undefined): AudioQuality | null {
  if (!id) return null;
  return QUALITY_BY_ID.get(id) ?? null;
}

export function qualityOr(fallbackId: string | null | undefined): AudioQuality {
  return resolveQuality(fallbackId) ?? QUALITY_BY_ID.get(DEFAULT_QUALITY)!;
}

/** File extension for a rung. */
export function extensionForQuality(quality: AudioQuality): "mp3" | "wav" {
  return quality.family === "mp3" ? "mp3" : "wav";
}

export function contentTypeForQuality(quality: AudioQuality): "audio/mpeg" | "audio/wav" {
  return quality.family === "mp3" ? "audio/mpeg" : "audio/wav";
}

/** Exact byte size of a WAV render (header + PCM). */
export function wavBytesFor(seconds: number, quality: AudioQuality): number {
  const depth = quality.bitDepth ?? 16;
  const frames = Math.max(1, Math.round(seconds * quality.sampleRate));
  // RIFF is 44 bytes; 24-bit and 8-bit payloads are not byte-aligned per frame,
  // so round up at the end like real encoders do.
  return 44 + Math.ceil((frames * depth * quality.channels) / 8);
}

/** Estimated size in bytes for a duration under a rung (MP3 ≈ CBR + ~2% tag/frame slack). */
export function estimateBytes(seconds: number, quality: AudioQuality): number {
  if (quality.family === "wav") return wavBytesFor(seconds, quality);
  return Math.round(seconds * quality.bytesPerSecond * 1.02);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Data saved versus a 320 kbps MP3 of the same length (0..1). */
export function dataSaving(quality: AudioQuality): number {
  const reference = 40000;
  if (quality.family === "wav") return 0;
  return Math.max(0, 1 - quality.bytesPerSecond / reference);
}

/* ------------------------------------------------------- video (MP4) ------ */

export type VideoTier = "240p" | "360p" | "480p" | "720p" | "1080p" | "1440p" | "4k" | "8k";

export interface VideoQuality {
  id: VideoTier;
  label: string;
  width: number;
  height: number;
  /** Frames per second used by the exporter. */
  fps: number;
  /** H.264 target bitrate in kbps. */
  videoKbps: number;
  /** True when this rung is slow enough to need a warning. */
  heavy: boolean;
  note: string;
}

export const VIDEO_QUALITIES: VideoQuality[] = [
  { id: "240p", label: "240p · data saver", width: 426, height: 240, fps: 24, videoKbps: 350, heavy: false, note: "Tiny MP4 — good for sharing on a slow connection." },
  { id: "360p", label: "360p", width: 640, height: 360, fps: 30, videoKbps: 700, heavy: false, note: "Phone-sized video card." },
  { id: "480p", label: "480p", width: 854, height: 480, fps: 30, videoKbps: 1200, heavy: false, note: "Standard definition." },
  { id: "720p", label: "720p HD", width: 1280, height: 720, fps: 30, videoKbps: 2500, heavy: false, note: "HD — the usual pick for WhatsApp/YouTube uploads." },
  { id: "1080p", label: "1080p Full HD", width: 1920, height: 1080, fps: 30, videoKbps: 4500, heavy: false, note: "Full HD; encode time is a few seconds per 10 s of video." },
  { id: "1440p", label: "1440p QHD", width: 2560, height: 1440, fps: 30, videoKbps: 9000, heavy: true, note: "Quad HD — noticeably slower to encode." },
  { id: "4k", label: "4K UHD", width: 3840, height: 2160, fps: 30, videoKbps: 20000, heavy: true, note: "4K. Encoding happens on your device and can take minutes." },
  { id: "8k", label: "8K UHD", width: 7680, height: 4320, fps: 24, videoKbps: 60000, heavy: true, note: "8K (7680×4320). Very demanding — keep the clip short, or the tab will sweat." },
];

export const VIDEO_BY_ID = new Map(VIDEO_QUALITIES.map((v) => [v.id, v]));

export function videoQualityOr(id: string | null | undefined): VideoQuality {
  return VIDEO_BY_ID.get((id ?? "") as VideoTier) ?? VIDEO_BY_ID.get("720p")!;
}

/** Rough MP4 size estimate: video bitrate + AAC audio bitrate. */
export function estimateVideoBytes(seconds: number, video: VideoQuality, audioKbps = 128): number {
  return Math.round((seconds * (video.videoKbps + audioKbps) * 1000) / 8);
}
