/**
 * Audio for saved web songs.
 *
 * `/api/stream/<web_id>` needs bytes. Two sources, in order:
 *   1. the resolved lawful URL (iTunes preview, archive.org file, Jamendo) —
 *      downloaded once into `.data/web-audio/` and served from there with Range
 *      support, so seeking works and repeat plays are instant;
 *   2. a deterministic synth preview generated from the song's id when no
 *      licensed recording exists — clearly reported as `generated`.
 *
 * Nothing outside `SONGHUB_DATA_DIR` is ever written.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PlaybackKind } from "../types";
import { DATA_DIR, ensureDir, listFiles, readBinary, removeFile, writeBinary } from "../storage";
import { encodeWav } from "../audio/wav";
import { RENDER_RATE, renderRange } from "../audio/synth";
import { hashString } from "../util";
import { getWebTrack, specForWebTrack } from "./weblibrary";
import { isSafeAudioUrl } from "./resolve";

const AUDIO_DIR = path.join(DATA_DIR, "web-audio");
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_CACHE_FILES = 200;
const FETCH_TIMEOUT_MS = 20_000;
export const WEB_PREVIEW_SECONDS = 30;

export interface WebAudio {
  bytes: Buffer;
  contentType: string;
  playbackKind: PlaybackKind;
  /** True when the bytes came from the on-disk cache. */
  cached: boolean;
  audioUrl?: string;
}

function extensionFor(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac")) return "m4a";
  if (contentType.includes("ogg") || contentType.includes("opus")) return "ogg";
  if (contentType.includes("flac")) return "flac";
  if (contentType.includes("webm")) return "webm";
  return "bin";
}

function contentTypeFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "webm":
      return "audio/webm";
    default:
      return "audio/wav";
  }
}

function cachePrefix(id: string): string {
  return `${id}-`;
}

async function findCached(id: string): Promise<{ file: string; bytes: Buffer } | null> {
  const files = await listFiles(AUDIO_DIR);
  const match = files.find((file) => file.startsWith(cachePrefix(id)));
  if (!match) return null;
  const bytes = await readBinary(path.join(AUDIO_DIR, match));
  return bytes ? { file: match, bytes } : null;
}

async function pruneCache(): Promise<void> {
  const files = await listFiles(AUDIO_DIR);
  if (files.length <= MAX_CACHE_FILES) return;
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(path.join(AUDIO_DIR, file));
        return { file, mtime: stat.mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  for (const entry of stats.slice(0, Math.max(0, stats.length - MAX_CACHE_FILES))) {
    await removeFile(path.join(AUDIO_DIR, entry.file));
  }
}

/** Render a deterministic 30 s preview for a web song with no lawful audio. */
export async function renderWebPreview(id: string): Promise<{ bytes: Buffer; durationSec: number }> {
  const web = await getWebTrack(id);
  const spec = specForWebTrack(web ?? { id, durationSec: WEB_PREVIEW_SECONDS });
  const total = Math.round(WEB_PREVIEW_SECONDS * RENDER_RATE);
  // `renderRange` is a pure function of time, so this is reproducible per song.
  const samples = renderRange(spec, 0, total, RENDER_RATE);
  return { bytes: Buffer.from(encodeWav(samples, RENDER_RATE)), durationSec: WEB_PREVIEW_SECONDS };
}

async function downloadAudio(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "SongHub/1.0 (+personal music assistant)",
        accept: "audio/*,*/*;q=0.8",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    // Refuse oversized files *before* reading them into memory.
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength < 2048 || buffer.byteLength > MAX_AUDIO_BYTES) return null;
    const contentType = (res.headers.get("content-type") ?? "audio/mpeg").split(";")[0].trim() || "audio/mpeg";
    return { bytes: buffer, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load (and cache) the audio for a web song. Returns null when the id is not a
 * saved web song. Never throws: the synthesized preview is the safety net.
 */
export async function loadWebAudio(id: string): Promise<WebAudio | null> {
  const web = await getWebTrack(id);
  if (!web) return null;

  const cached = await findCached(id);
  if (cached) {
    return {
      bytes: cached.bytes,
      contentType: contentTypeFor(cached.file),
      playbackKind: web.playbackKind,
      cached: true,
      audioUrl: web.audioUrl,
    };
  }

  if (web.audioUrl && isSafeAudioUrl(web.audioUrl)) {
    const downloaded = await downloadAudio(web.audioUrl);
    if (downloaded) {
      await ensureDir(AUDIO_DIR);
      const key = hashString(web.audioUrl).toString(36);
      const fileName = `${id}-${key}.${extensionFor(downloaded.contentType)}`;
      await writeBinary(path.join(AUDIO_DIR, fileName), downloaded.bytes);
      void pruneCache();
      return {
        bytes: downloaded.bytes,
        contentType: downloaded.contentType,
        playbackKind: web.playbackKind,
        cached: false,
        audioUrl: web.audioUrl,
      };
    }
  }

  // No lawful recording (or it went away): synthesise a preview so the song is
  // still playable and the UI can say exactly what it is.
  const preview = await renderWebPreview(id);
  await ensureDir(AUDIO_DIR);
  await writeBinary(path.join(AUDIO_DIR, `${id}-synth.wav`), preview.bytes);
  void pruneCache();
  return {
    bytes: preview.bytes,
    contentType: "audio/wav",
    playbackKind: "generated",
    cached: false,
    audioUrl: web.audioUrl,
  };
}

/** Remove cached audio for a web song (called when the song is deleted). */
export async function clearWebAudio(id: string): Promise<number> {
  const files = (await listFiles(AUDIO_DIR)).filter((file) => file.startsWith(cachePrefix(id)));
  await Promise.all(files.map((file) => removeFile(path.join(AUDIO_DIR, file))));
  return files.length;
}
