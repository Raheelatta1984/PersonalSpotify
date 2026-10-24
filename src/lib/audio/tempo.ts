/** Tempo estimation from an onset envelope (autocorrelation of spectral flux). */

import { fft } from "./fingerprint";

const FRAME = 1024;
const HOP = 256;

/** Onset strength envelope: half-wave rectified difference of frame energies. */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): { envelope: Float32Array; framesPerSecond: number } {
  const frames = Math.max(1, Math.floor((samples.length - FRAME) / HOP) + 1);
  const envelope = new Float32Array(frames);
  let previous = 0;
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    // focus on the percussive band (60–4000 Hz) so pads don't dominate
    let energy = 0;
    for (let i = 0; i < FRAME; i += 2) {
      const s = samples[offset + i] ?? 0;
      energy += s * s;
    }
    // a light spectral pass sharpens transient detection
    if (f % 2 === 0) {
      for (let i = 0; i < FRAME; i++) {
        re[i] = samples[offset + i] ?? 0;
        im[i] = 0;
      }
      fft(re, im);
      let flux = 0;
      for (let b = 8; b < FRAME / 2; b++) {
        const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
        flux += mag;
      }
      energy += flux * 0.02;
    }
    const diff = energy - previous;
    envelope[f] = diff > 0 ? diff : 0;
    previous = energy;
  }

  return { envelope, framesPerSecond: sampleRate / HOP };
}

/**
 * Estimate BPM in the 50–200 range by autocorrelating the onset envelope and
 * picking the strongest plausible period (weighted towards 90–140 BPM).
 */
export function estimateTempo(samples: Float32Array, sampleRate: number): number {
  const { envelope, framesPerSecond } = onsetEnvelope(samples, sampleRate);
  if (envelope.length < 8) return 0;

  // remove the mean so autocorrelation measures periodicity, not loudness
  let mean = 0;
  for (let i = 0; i < envelope.length; i++) mean += envelope[i];
  mean /= envelope.length;
  const centred = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) centred[i] = envelope[i] - mean;

  const minBpm = 50;
  const maxBpm = 200;
  const minLag = Math.floor((60 / maxBpm) * framesPerSecond);
  const maxLag = Math.ceil((60 / minBpm) * framesPerSecond);
  if (maxLag >= centred.length) return 0;

  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let norm = 0;
    for (let i = 0; i + lag < centred.length; i++) {
      sum += centred[i] * centred[i + lag];
      norm += centred[i] * centred[i];
    }
    const score = norm > 0 ? sum / norm : 0;
    const bpm = (60 * framesPerSecond) / lag;
    // mild prior around typical dance/pop tempi
    const prior = Math.exp(-Math.pow((bpm - 115) / 60, 2));
    const weighted = score * (0.7 + 0.3 * prior);
    if (weighted > bestScore) {
      bestScore = weighted;
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return 0;
  let bpm = (60 * framesPerSecond) / bestLag;
  // octave correction into a musically useful range
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
