/**
 * Temporary ("post-download") playback cache.
 *
 * Flow: an online result -> POST /api/online/download -> the audio is copied into
 * `.data/downloads/<token>` with an expiry stamp -> the browser streams it from
 * `/api/temp/<token>` -> a sweeper deletes it after the TTL (default 10 min).
 *
 * Nothing is ever written outside the temp folder and nothing survives the TTL,
 * which is the "download temporarily, play, then forget" behaviour the app wants.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OnlineResult, TempDownload } from "../types";
import { ANALYSIS_RATE, renderRange, trackSampleCount } from "../audio/synth";
import { encodeWav } from "../audio/wav";
import { DOWNLOAD_DIR, ensureDir, readJson, writeJson, removeFile, listFiles } from "../storage";
import { TRACKS } from "../catalog/tracks";
import { hashString } from "../util";

export const DEFAULT_TTL_SECONDS = 600;
export const MAX_TTL_SECONDS = 1800;
export const PREVIEW_SECONDS = 30;
const REGISTRY_FILE = "cache/downloads.json";

interface RegistryEntry {
  token: string;
  title: string;
  artist: string;
  source: string;
  sourceUrl: string;
  fileName: string;
  contentType: string;
  createdAt: string;
  expiresAt: string;
  license: string;
  live: boolean;
}

type Registry = Record<string, RegistryEntry>;

async function readRegistry(): Promise<Registry> {
  return readJson<Registry>(REGISTRY_FILE, {});
}

async function writeRegistry(registry: Registry): Promise<void> {
  await writeJson(REGISTRY_FILE, registry);
}

export function makeToken(result: OnlineResult): string {
  const seed = `${result.id}|${Date.now()}|${Math.random()}`;
  return `${hashString(seed).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Render a fresh, deterministic 30 s preview of a catalog track. */
export function renderPreviewWav(trackId: string, seconds = PREVIEW_SECONDS): { bytes: Uint8Array; durationSec: number } {
  const track = TRACKS.find((t) => t.id === trackId) ?? TRACKS[0];
  const total = trackSampleCount(track.spec, ANALYSIS_RATE);
  const take = Math.min(total, Math.round(seconds * ANALYSIS_RATE));
  const samples = renderRange(track.spec, 0, take, ANALYSIS_RATE);
  const bytes = encodeWav(samples, ANALYSIS_RATE);
  return { bytes, durationSec: take / ANALYSIS_RATE };
}

async function fetchAudio(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "SongHub/1.0" }, cache: "no-store" });
    if (!res.ok) return null;
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength < 1024) return null;
    const contentType = res.headers.get("content-type") ?? "audio/mpeg";
    return { bytes: buffer, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extensionFor(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac")) return "m4a";
  if (contentType.includes("ogg")) return "ogg";
  return "mp3";
}

export interface PrepareDownloadOptions {
  ttlSeconds?: number;
}

export async function prepareTempDownload(
  result: OnlineResult,
  options: PrepareDownloadOptions = {},
): Promise<TempDownload> {
  await ensureDir(DOWNLOAD_DIR);
  const ttl = Math.min(Math.max(options.ttlSeconds ?? DEFAULT_TTL_SECONDS, 30), MAX_TTL_SECONDS);
  const token = makeToken(result);
  const now = Date.now();

  let bytes: Uint8Array | null = null;
  let contentType = "audio/wav";
  let fileName = `${token}.wav`;
  let live = false;

  if (result.audioUrl) {
    const fetched = await fetchAudio(result.audioUrl);
    if (fetched) {
      bytes = fetched.bytes;
      contentType = fetched.contentType;
      fileName = `${token}.${extensionFor(contentType)}`;
      live = true;
    }
  }

  if (!bytes) {
    // Fall back to a generated preview so the user can still hear *something*
    // and the flow stays demonstrable without network access.
    const track = TRACKS.find((t) => t.title === result.title && t.artist === result.artist) ?? TRACKS[hashString(result.id) % TRACKS.length];
    const preview = renderPreviewWav(track.id);
    bytes = preview.bytes;
    contentType = "audio/wav";
    fileName = `${token}.wav`;
    live = false;
  }

  const fullPath = path.join(DOWNLOAD_DIR, fileName);
  await fs.writeFile(fullPath, bytes);

  const entry: RegistryEntry = {
    token,
    title: result.title,
    artist: result.artist,
    source: result.source,
    sourceUrl: result.sourceUrl,
    fileName,
    contentType,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    license: result.license,
    live,
  };

  const registry = await readRegistry();
  registry[token] = entry;
  await writeRegistry(registry);

  return {
    token,
    title: entry.title,
    artist: entry.artist,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    fileName: entry.fileName,
    bytes: bytes.byteLength,
    contentType: entry.contentType,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    ttlSeconds: ttl,
    live: entry.live,
    license: entry.license,
    streamUrl: `/api/temp/${token}`,
  };
}

export interface TempFile {
  entry: RegistryEntry;
  path: string;
  bytes: number | null;
  expired: boolean;
}

export async function getTempFile(token: string): Promise<TempFile | null> {
  const registry = await readRegistry();
  const entry = registry[token];
  if (!entry) return null;
  const fullPath = path.join(DOWNLOAD_DIR, entry.fileName);
  let bytes: number | null = null;
  try {
    const stat = await fs.stat(fullPath);
    bytes = stat.size;
  } catch {
    bytes = null;
  }
  return { entry, path: fullPath, bytes, expired: Date.parse(entry.expiresAt) <= Date.now() };
}

export async function readTempBytes(token: string): Promise<{ bytes: Buffer; contentType: string; expiresAt: string } | null> {
  const file = await getTempFile(token);
  if (!file || file.expired) {
    if (file?.expired) await deleteTempDownload(token);
    return null;
  }
  try {
    const bytes = await fs.readFile(file.path);
    return { bytes, contentType: file.entry.contentType, expiresAt: file.entry.expiresAt };
  } catch {
    return null;
  }
}

export async function deleteTempDownload(token: string): Promise<boolean> {
  const registry = await readRegistry();
  const entry = registry[token];
  if (!entry) return false;
  await removeFile(path.join(DOWNLOAD_DIR, entry.fileName));
  delete registry[token];
  await writeRegistry(registry);
  return true;
}

export interface SweepReport {
  removed: string[];
  remaining: number;
}

/** Delete everything past its TTL (called opportunistically + by tests/CLI). */
export async function sweepExpired(now = Date.now()): Promise<SweepReport> {
  const registry = await readRegistry();
  const removed: string[] = [];
  for (const [token, entry] of Object.entries(registry)) {
    if (Date.parse(entry.expiresAt) <= now) {
      await removeFile(path.join(DOWNLOAD_DIR, entry.fileName));
      delete registry[token];
      removed.push(token);
    }
  }
  // orphan files (no registry entry) are also garbage
  const known = new Set(Object.values(registry).map((e) => e.fileName));
  for (const file of await listFiles(DOWNLOAD_DIR)) {
    if (!known.has(file)) await removeFile(path.join(DOWNLOAD_DIR, file));
  }
  if (removed.length) await writeRegistry(registry);
  return { removed, remaining: Object.keys(registry).length };
}

export async function listTempDownloads(): Promise<TempDownload[]> {
  const registry = await readRegistry();
  return Object.values(registry)
    .filter((e) => Date.parse(e.expiresAt) > Date.now())
    .map((entry) => {
      const ttlSeconds = Math.max(0, Math.round((Date.parse(entry.expiresAt) - Date.now()) / 1000));
      return {
        token: entry.token,
        title: entry.title,
        artist: entry.artist,
        source: entry.source,
        sourceUrl: entry.sourceUrl,
        fileName: entry.fileName,
        bytes: 0,
        contentType: entry.contentType,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        ttlSeconds,
        live: entry.live,
        license: entry.license,
        streamUrl: `/api/temp/${entry.token}`,
      };
    });
}
