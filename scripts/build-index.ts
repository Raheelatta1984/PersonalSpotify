/**
 * Pre-build the audio fingerprint index.
 *
 *   npm run index:audio
 *
 * Renders every catalog track through the synth at the analysis rate,
 * fingerprints it, and writes `.data/cache/fingerprint-index.json`.
 * The server loads this file on boot, so "identify" is instant after the first
 * build. Safe to re-run: it overwrites.
 */

import { TRACKS } from "../src/lib/catalog/tracks";
import { ANALYSIS_RATE, renderRange, trackSampleCount } from "../src/lib/audio/synth";
import { fingerprintSamples } from "../src/lib/audio/fingerprint";
import { buildFingerprintIndex } from "../src/lib/audio/identify";

async function main() {
  console.log(`SongHub index builder — ${TRACKS.length} tracks @ ${ANALYSIS_RATE} Hz`);
  const started = Date.now();

  // quick per-track sanity report first
  for (const track of TRACKS.slice(0, 1)) {
    const samples = renderRange(track.spec, 0, trackSampleCount(track.spec, ANALYSIS_RATE), ANALYSIS_RATE);
    const fp = fingerprintSamples(samples, ANALYSIS_RATE);
    console.log(
      `  sample -> ${track.title}: ${fp.peakCount} peaks, ${fp.hashes.size} distinct hashes, ${fp.durationSec.toFixed(1)}s`,
    );
  }

  let lastPct = -1;
  const index = await buildFingerprintIndex((progress) => {
    const pct = Math.round(progress * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      console.log(`  ${pct}%`);
    }
  });

  console.log(
    `done in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
      `${index.trackCount} tracks, ${index.totalHashes.toLocaleString()} hash entries, ` +
      `${index.map.size.toLocaleString()} distinct hashes`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
