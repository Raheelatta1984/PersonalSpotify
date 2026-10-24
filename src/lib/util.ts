/** Deterministic hashing + PRNG helpers. Everything in SongHub is reproducible. */

/** FNV-1a 32-bit string hash. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — fast, deterministic, good enough for music/synthesis noise. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless deterministic white noise in [-1, 1] for a given integer index + seed. */
export function noiseAt(index: number, seed: number): number {
  let x = (index + seed * 0x9e3779b9) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;
  x >>>= 0;
  return (x / 4294967296) * 2 - 1;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function roundTo(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** MIDI note number -> frequency in Hz. */
export function midiToHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToName(note: number): string {
  const n = ((note % 12) + 12) % 12;
  return `${NOTE_NAMES[n]}${Math.floor(note / 12) - 1}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Process-wide shared state.
 *
 * Next.js bundles every route handler separately, so a plain module-level
 * singleton can be instantiated once per route. Hanging shared state off
 * `globalThis` gives one instance per server process, which is what caches
 * (search index, audio fingerprints, rendered WAV buffers) actually need.
 */
const sharedRoot = globalThis as unknown as { __songhub?: Map<string, unknown> };
const sharedStore: Map<string, unknown> = (sharedRoot.__songhub ??= new Map());

export function sharedState<T>(key: string, init: () => T): T {
  if (!sharedStore.has(key)) sharedStore.set(key, init());
  return sharedStore.get(key) as T;
}
