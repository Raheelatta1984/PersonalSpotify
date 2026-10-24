/**
 * Next.js server-boot hook.
 *
 * Warm the audio fingerprint index in the background so the first "identify"
 * request doesn't pay the 16-second build cost. If a prebuilt index exists in
 * `.data/cache/` (see `npm run index:audio`) this is just a disk read.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { warmFingerprintIndex } = await import("./src/lib/audio/identify");
    warmFingerprintIndex();
  } catch {
    // never block boot on the index
  }
}
