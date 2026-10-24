/**
 * Tiny file-backed store for runtime state.
 *
 * Everything is JSON on disk under `.data/` (gitignored) or `SONGHUB_DATA_DIR`,
 * which keeps the app dependency-free while still surviving restarts.
 * Writes are atomic-ish (write temp + rename) and serialised per file.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const DATA_DIR = process.env.SONGHUB_DATA_DIR ?? path.join(process.cwd(), ".data");
export const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
export const CACHE_DIR = path.join(DATA_DIR, "cache");

const queues = new Map<string, Promise<unknown>>();

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Serialise writes per file so concurrent requests can't interleave. */
export function writeJson(file: string, value: unknown): Promise<void> {
  const target = path.join(DATA_DIR, file);
  const previous = queues.get(target) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await ensureDir(path.dirname(target));
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
      await fs.rename(tmp, target);
    });
  queues.set(target, next);
  return next;
}

export async function writeBinary(file: string, data: Buffer | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function readBinary(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export async function removeFile(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    /* already gone */
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
