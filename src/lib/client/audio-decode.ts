"use client";

/**
 * Browser-side audio decoding for the "identify" feature.
 *
 * MediaRecorder gives us webm/opus (often 48 kHz), uploaded files can be
 * anything. The analyser only needs 8 kHz mono, so we decode with Web Audio,
 * mix to mono, resample with an OfflineAudioContext and hand the server a plain
 * Int16Array — no ffmpeg, no dependency, works identically for mic + upload.
 */

export const TARGET_RATE = 8000;

export interface DecodedClip {
  pcm: Int16Array;
  sampleRate: number;
  durationSec: number;
  peak: number;
}

export async function decodeToPcm(input: Blob | ArrayBuffer): Promise<DecodedClip> {
  const buffer = input instanceof Blob ? await input.arrayBuffer() : input;
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const channels = decoded.numberOfChannels;
    const frames = decoded.length;

    // mix to mono
    const mono = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < frames; i++) mono[i] += data[i] / channels;
    }

    // resample with an OfflineAudioContext (browser does high-quality SRC)
    const targetLength = Math.max(1, Math.round((frames / decoded.sampleRate) * TARGET_RATE));
    let resampled: Float32Array;
    if (decoded.sampleRate === TARGET_RATE) {
      resampled = mono;
    } else {
      const offline = new OfflineAudioContext(1, targetLength, TARGET_RATE);
      const src = offline.createBufferSource();
      const monoBuffer = offline.createBuffer(1, frames, decoded.sampleRate);
      monoBuffer.copyToChannel(mono, 0);
      src.buffer = monoBuffer;
      src.connect(offline.destination);
      src.start();
      const rendered = await offline.startRendering();
      resampled = rendered.getChannelData(0);
    }

    let peak = 0;
    const pcm = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const s = Math.max(-1, Math.min(1, resampled[i]));
      peak = Math.max(peak, Math.abs(s));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    return {
      pcm,
      sampleRate: TARGET_RATE,
      durationSec: resampled.length / TARGET_RATE,
      peak,
    };
  } finally {
    void ctx.close();
  }
}

export function pcmToBody(pcm: Int16Array): ArrayBuffer {
  // Copy into a fresh buffer so the ArrayBuffer is exactly sized for fetch().
  const out = new ArrayBuffer(pcm.length * 2);
  new Int16Array(out).set(pcm);
  return out;
}

export interface MicSession {
  stop: () => Promise<Blob>;
  dispose: () => void;
  /** 0..1 loudness, sampled every animation frame. */
  getLevel: () => number;
}

/** Start a microphone recording; resolves once the stream is live. */
export async function startMicSession(): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start(250);

  return {
    getLevel: () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / data.length) * 5);
    },
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        recorder.stop();
        stream.getTracks().forEach((track) => track.stop());
        void ctx.close();
      }),
    dispose: () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
    },
  };
}
