/**
 * Deterministic synthesis engine.
 *
 * The whole SongHub catalog is *generated* rather than sampled, which means:
 *  - zero licensing problems,
 *  - byte-identical audio on every render (great for fingerprint tests),
 *  - any byte range of a track can be rendered on demand (perfect seeking),
 *  - the same code renders on the server for analysis and for streaming.
 *
 * `sampleAt()` is a pure function of (spec, sample index) — no filter state,
 * no randomness beyond a stateless hash — so a Range request for second 90
 * sounds exactly like the same second inside a full render.
 */

import { noiseAt, midiToHz, clamp } from "../util";
import type { TrackSpec } from "../types";

export const RENDER_RATE = 22050;
export const ANALYSIS_RATE = 8000;

const TABLE_SIZE = 4096;
const SINE = new Float32Array(TABLE_SIZE + 1);
for (let i = 0; i <= TABLE_SIZE; i++) SINE[i] = Math.sin((i / TABLE_SIZE) * Math.PI * 2);

/** Wavetable sine: phase is in cycles (0..1 = one period). */
function osc(phase: number): number {
  const p = phase - Math.floor(phase);
  const x = p * TABLE_SIZE;
  const i = x | 0;
  const frac = x - i;
  const a = SINE[i];
  const b = SINE[i + 1];
  return a + (b - a) * frac;
}

function tri(phase: number): number {
  const p = phase - Math.floor(phase);
  return 1 - 4 * Math.abs(p - 0.5);
}

/** exp(-x) lookup: x in [0,8], linear interpolation. ~8x faster than Math.exp. */
const EXP_TABLE_SIZE = 1024;
const EXP_MAX = 8;
const EXP_TABLE = new Float32Array(EXP_TABLE_SIZE + 2);
for (let i = 0; i <= EXP_TABLE_SIZE + 1; i++) EXP_TABLE[i] = Math.exp(-(i / EXP_TABLE_SIZE) * EXP_MAX);

function fastExpNeg(x: number): number {
  if (x <= 0) return 1;
  if (x >= EXP_MAX) return 0;
  const f = (x / EXP_MAX) * EXP_TABLE_SIZE;
  const i = f | 0;
  const frac = f - i;
  return EXP_TABLE[i] + (EXP_TABLE[i + 1] - EXP_TABLE[i]) * frac;
}

function expDecay(t: number, tau: number): number {
  return t < 0 ? 0 : fastExpNeg(t / tau);
}

/** tanh approximation (Padé 3/2) — monotonic, saturates like tanh near ±1. */
function softClip(x: number): number {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

function adsr(local: number, length: number, attack = 0.01, release = 0.08): number {
  if (local < 0 || local > length + release) return 0;
  const a = local < attack ? local / attack : 1;
  const r = local > length ? 1 - (local - length) / release : 1;
  return a * clamp(r, 0, 1);
}

/** Scale degree -> semitone offset, wrapping octaves for degrees beyond the scale. */
function degreeToSemitone(scale: number[], degree: number): number {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return scale[idx] + oct * 12;
}

export function trackDurationSec(spec: TrackSpec): number {
  return (spec.bars * 4 * 60) / spec.bpm;
}

export function trackSampleCount(spec: TrackSpec, rate = RENDER_RATE): number {
  return Math.max(1, Math.round(trackDurationSec(spec) * rate));
}

interface Grid {
  secPerBeat: number;
  secPerBar: number;
  totalBars: number;
  bar: number;
  beatInBar: number;
  beat: number;
}

function gridAt(spec: TrackSpec, t: number): Grid {
  const secPerBeat = 60 / spec.bpm;
  const secPerBar = secPerBeat * 4;
  return {
    secPerBeat,
    secPerBar,
    totalBars: spec.bars,
    bar: Math.floor(t / secPerBar),
    beatInBar: (t % secPerBar) / secPerBeat,
    beat: t / secPerBeat,
  };
}

function chordTone(spec: TrackSpec, bar: number, tone: number): number {
  const root = spec.progression[((bar % spec.progression.length) + spec.progression.length) % spec.progression.length];
  return degreeToSemitone(spec.scale, root + tone * 2); // simple diatonic triad
}

/** Deterministic melodic motif: returns scale degree for an 8th-note slot. */
function melodyDegree(spec: TrackSpec, bar: number, step: number): number {
  const seed = spec.seed ^ (bar * 7919) ^ (step * 104729);
  const r = noiseAt(seed, spec.seed + 11);
  const choice = Math.floor(((r + 1) / 2) * 7);
  const contour = [0, 2, 4, 6, 4, 2, 1][choice % 7];
  return contour + (bar % 4 >= 2 ? 2 : 0);
}

/** One sample of the mix at time `t`. Pure. */
export function sampleAt(spec: TrackSpec, t: number): number {
  // guard the domain (negatives, NaN, past the end) before any music maths
  if (!(t >= 0)) return 0;
  const g = gridAt(spec, t);
  if (g.bar >= g.totalBars) return 0;

  const v = spec.voices;
  const swingOffset = spec.swing * (g.secPerBeat / 4) * 0.5;
  let out = 0;

  // ---- pad -------------------------------------------------------------
  if (v.pad) {
    const barTime = t - g.bar * g.secPerBar;
    const env = adsr(barTime, g.secPerBar * 0.98, 0.35, 0.25);
    const chord = [0, 1, 2].map((k) => midiToHz(spec.root + 12 + chordTone(spec, g.bar, k)));
    for (let k = 0; k < 3; k++) {
      const f = chord[k];
      out += 0.055 * env * (osc(f * t) + 0.32 * osc(f * 2.002 * t) + 0.11 * osc(f * 3.001 * t));
    }
  }

  // ---- shimmer ---------------------------------------------------------
  if (v.shimmer) {
    const trem = 0.55 + 0.45 * osc(t * 0.12);
    const f = midiToHz(spec.root + 36 + degreeToSemitone(spec.scale, spec.progression[g.bar % spec.progression.length]));
    out += 0.028 * trem * osc(f * t + 0.15 * osc(t * 0.07));
  }

  // ---- bass ------------------------------------------------------------
  if (v.bass) {
    const eighth = g.secPerBeat / 2;
    const slot = Math.floor(t / eighth);
    const local = t - slot * eighth;
    const pattern = [0, 0, 4, 0, 0, 3, 0, 2];
    const deg = pattern[(((slot % 8) + 8) % 8)] ?? 0;
    const f = midiToHz(spec.root - 12 + chordTone(spec, g.bar, 0) + deg);
    const env = expDecay(local, 0.22) * adsr(local, eighth * 0.9, 0.004, 0.02);
    out += 0.2 * env * (osc(f * t) + 0.28 * osc(2 * f * t));
  }

  // ---- arpeggio --------------------------------------------------------
  if (v.arp) {
    const sixteenth = g.secPerBeat / 4;
    const shifted = t + (Math.floor(t / sixteenth) % 2 === 0 ? 0 : swingOffset);
    const slot = Math.floor(shifted / sixteenth);
    const local = shifted - slot * sixteenth;
    const toneIdx = ((slot % 6) % 3) + (slot % 6 >= 3 ? 1 : 0);
    const octave = slot % 8 >= 4 ? 24 : 12;
    const f = midiToHz(spec.root + octave + chordTone(spec, g.bar, Math.min(2, toneIdx)));
    const env = expDecay(local, 0.09) * adsr(local, sixteenth, 0.003, 0.01);
    out += 0.075 * env * (tri(f * t) * 0.6 + 0.4 * osc(f * 2 * t));
  }

  // ---- pluck / lead melody --------------------------------------------
  if (v.pluck) {
    const eighth = g.secPerBeat / 2;
    const slot = Math.floor(t / eighth);
    const local = t - slot * eighth;
    const degree = melodyDegree(spec, g.bar, slot % 8);
    const f = midiToHz(spec.root + 24 + degreeToSemitone(spec.scale, degree));
    const env = expDecay(local, 0.16) * adsr(local, eighth * 0.85, 0.006, 0.03);
    const accent = slot % 4 === 0 ? 1 : 0.72;
    out += 0.085 * accent * env * (osc(f * t) + 0.22 * osc(f * 2 * t));
  }

  // ---- drums -----------------------------------------------------------
  if (v.drums) {
    const beat = g.beat;
    const beatIndex = Math.floor(beat);
    const beatLocal = (beat - beatIndex) * g.secPerBeat;

    // kick on every beat for high-tempo tracks, otherwise on 1 and 3
    const kickEveryBeat = spec.bpm > 104;
    const isKick = kickEveryBeat || beatIndex % 4 === 0 || beatIndex % 4 === 2;
    if (isKick) {
      const kt = beatLocal;
      if (kt < 0.5) {
        const pitchEnv = 118 * Math.exp(-kt / 0.035) + 44;
        const env = expDecay(kt, 0.14);
        out += 0.24 * env * osc(pitchEnv * t);
        out += 0.05 * env * noiseAt(Math.floor(t * 8000), spec.seed + 3) * 0.5;
      }
    }

    // snare on 2 and 4
    if (beatIndex % 4 === 1 || beatIndex % 4 === 3) {
      const st = beatLocal;
      if (st < 0.35) {
        const env = expDecay(st, 0.075);
        const n = noiseAt(Math.floor(t * 16000), spec.seed + 17);
        out += 0.11 * env * (n * 0.8 + 0.45 * osc(196 * t));
      }
    }

    // hats on 8ths
    const eighth = g.secPerBeat / 2;
    const ht = t - Math.floor(t / eighth) * eighth;
    if (ht < 0.08) {
      const env = expDecay(ht, 0.018);
      const i0 = Math.floor(t * 24000);
      const n = noiseAt(i0, spec.seed + 31) - noiseAt(i0 - 1, spec.seed + 31);
      out += 0.055 * env * (n * 3.2);
    }
  }

  // ---- tabla / dholak (16th-note theka) --------------------------------
  if (v.tabla) {
    const sixteenth = g.secPerBeat / 4;
    const slot = Math.floor(t / sixteenth);
    const local = t - slot * sixteenth;
    // Teentaal-ish theka: dha · na · tin · na · dha dha tin · na · dhin
    const THEKA = [1, 0, 2, 0, 3, 0, 2, 0, 1, 1, 3, 0, 2, 0, 4, 0];
    const stroke = THEKA[((slot % 16) + 16) % 16];
    if (stroke) {
      const accent = stroke === 1 ? 1 : stroke === 4 ? 0.92 : 0.72;
      const decay = stroke === 1 ? 0.17 : stroke === 3 ? 0.085 : 0.12;
      const env = expDecay(local, decay) * adsr(local, sixteenth * 0.95, 0.002, 0.02);
      // bayan (bass drum) glides down after the strike; dayan (rim) sits higher
      const base = stroke === 1 ? 94 : stroke === 4 ? 84 : 176;
      const pitch = base * (1 + 0.85 * fastExpNeg(local / 0.022));
      out += 0.155 * accent * env * osc(pitch * t);
      // skin/rim crack
      const n = noiseAt(Math.floor(t * 20000), spec.seed + 71);
      out += 0.05 * accent * env * n;
      // metallic ring of the dayan
      if (stroke !== 1) out += 0.018 * env * osc(412 * t) * (0.5 + 0.5 * osc(3.1 * t));
    }
  }

  // ---- sitar (plucked, with meend glide) -------------------------------
  if (v.sitar) {
    const eighth = g.secPerBeat / 2;
    const slot = Math.floor(t / eighth);
    const local = t - slot * eighth;
    const degree = melodyDegree(spec, g.bar, slot % 8) + (slot % 4 === 3 ? 1 : 0);
    const target = midiToHz(spec.root + 24 + degreeToSemitone(spec.scale, degree));
    const glide = 1 + 0.055 * fastExpNeg(local / 0.035); // bend into the note
    const f = target * glide;
    const env = expDecay(local, 0.55) * adsr(local, eighth * 1.6, 0.004, 0.08);
    out +=
      0.062 *
      env *
      (osc(f * t) + 0.45 * osc(2.01 * f * t) + 0.22 * osc(3.02 * f * t) + 0.09 * osc(4.98 * f * t));
    // sympathetic strings blooming after the pluck
    out += 0.012 * expDecay(local, 1.1) * osc(target * 2.005 * t);
  }

  // ---- bansuri / flute lead -------------------------------------------
  if (v.flute) {
    const half = g.secPerBar / 2;
    const slot = Math.floor(t / half);
    const local = t - slot * half;
    const degree = melodyDegree(spec, g.bar, slot % 4) + (g.bar % 2 ? 2 : 0);
    const f = midiToHz(spec.root + 24 + degreeToSemitone(spec.scale, degree));
    const vibrato = 1 + 0.0065 * osc(t * 5.2);
    const env = adsr(local, half * 0.86, 0.16, 0.3);
    out += 0.06 * env * (osc(f * vibrato * t) + 0.18 * osc(2 * f * t) + 0.05 * osc(3 * f * t));
    // breath noise rides the phrase
    const breath = noiseAt(Math.floor(t * 12000), spec.seed + 43);
    out += 0.011 * env * breath * (0.6 + 0.4 * osc(t * 3.3));
  }

  // ---- string section (filmi orchestra swell) -------------------------
  if (v.strings) {
    const barTime = t - g.bar * g.secPerBar;
    const swell = adsr(barTime, g.secPerBar * 0.99, 0.55, 0.5) * (0.62 + 0.38 * osc(t * 0.09));
    const chord = [0, 1, 2].map((k) => midiToHz(spec.root + 12 + chordTone(spec, g.bar, k)));
    for (let k = 0; k < 3; k++) {
      const f = chord[k] * (1 + 0.002 * osc(t * 5.5 + k));
      out += 0.028 * swell * (0.5 * tri(f * t) + 0.5 * osc(f * t) + 0.22 * osc(2 * f * t));
    }
  }

  // ---- master trim + gentle saturation --------------------------------
  const saturated = softClip(out * spec.gain * 1.35) * 0.92;
  // global fade in/out to avoid clicks
  const total = trackDurationSec(spec);
  const fadeIn = clamp(t / 0.8, 0, 1);
  const fadeOut = clamp((total - t) / 1.6, 0, 1);
  return saturated * fadeIn * fadeOut;
}

/** Render `count` samples starting at absolute sample index `startSample`. */
export function renderRange(
  spec: TrackSpec,
  startSample: number,
  count: number,
  rate = RENDER_RATE,
): Float32Array {
  const out = new Float32Array(count);
  const dt = 1 / rate;
  for (let i = 0; i < count; i++) {
    out[i] = sampleAt(spec, (startSample + i) * dt);
  }
  return out;
}

export function renderTrack(spec: TrackSpec, rate = RENDER_RATE): Float32Array {
  return renderRange(spec, 0, trackSampleCount(spec, rate), rate);
}

export interface PcmAnalysis {
  peakAmplitude: number;
  rms: number;
  durationSec: number;
  sampleRate: number;
  zeroCrossingRate: number;
}

export function analyzePcm(samples: Float32Array, sampleRate: number): PcmAnalysis {
  let peak = 0;
  let sumSq = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
    if (i > 0 && (samples[i - 1] < 0) !== (s < 0)) crossings++;
  }
  return {
    peakAmplitude: peak,
    rms: samples.length ? Math.sqrt(sumSq / samples.length) : 0,
    durationSec: samples.length / sampleRate,
    sampleRate,
    zeroCrossingRate: samples.length ? crossings / samples.length : 0,
  };
}

/**
 * Dominant-frequency estimate via normalised autocorrelation (60–1200 Hz).
 *
 * Octave errors are the classic failure mode here: a pure 220 Hz tone also
 * correlates strongly at 2× and 3× the period. We therefore collect every
 * strong local maximum and take the *shortest* lag that is nearly as good as the
 * best one, which lands on the fundamental instead of a harmonic.
 */
export function estimatePitch(samples: Float32Array, sampleRate: number): number {
  const windowSize = Math.min(samples.length, 8192);
  if (windowSize < 256) return 0;
  const start = Math.max(0, Math.floor((samples.length - windowSize) / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / 1200));
  const maxLag = Math.min(Math.floor(sampleRate / 60), Math.floor(windowSize / 2));

  const scores = new Float32Array(maxLag + 1);
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    const count = windowSize - lag;
    for (let i = 0; i < count; i += 2) {
      const a = samples[start + i];
      const b = samples[start + i + lag];
      sum += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    const score = denom > 0 ? sum / denom : 0;
    scores[lag] = score;
    if (score > bestScore) bestScore = score;
  }

  if (bestScore <= 0.2) return 0;

  // shortest local maximum that is nearly as strong as the global one
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= bestScore * 0.9 && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
      return refinePeriod(scores, lag, sampleRate);
    }
  }

  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (scores[lag] > scores[bestLag]) bestLag = lag;
  return refinePeriod(scores, bestLag, sampleRate);
}

/** Parabolic interpolation around the peak for sub-sample accuracy. */
function refinePeriod(scores: Float32Array, lag: number, sampleRate: number): number {
  let period = lag;
  if (lag > 1 && lag < scores.length - 1) {
    const a = scores[lag - 1];
    const b = scores[lag];
    const c = scores[lag + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (a - c)) / denom;
      if (Math.abs(delta) < 1) period = lag + delta;
    }
  }
  return period > 0 ? sampleRate / period : 0;
}
