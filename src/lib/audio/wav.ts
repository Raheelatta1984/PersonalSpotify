/** WAV (RIFF/PCM 16-bit) encoding helpers. Used by the audio route and the analyser. */

export const WAV_HEADER_BYTES = 44;

export type WavBitDepth = 8 | 16 | 24;

/**
 * Encode mono/stereo PCM. `bitDepth` covers the three depths SongHub offers:
 * 8-bit (byte-sized lo-fi recordings), 16-bit (CD) and 24-bit (studio master).
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  channels = 1,
  bitDepth: WavBitDepth = 16,
): Uint8Array {
  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(samples.length / channels);
  const dataBytes = frames * channels * bytesPerSample;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    if (bitDepth === 8) {
      // 8-bit PCM is unsigned with 128 as silence.
      view.setUint8(offset, Math.max(0, Math.min(255, Math.round(s * 127) + 128)));
      offset += 1;
    } else if (bitDepth === 24) {
      const v = Math.max(-8388608, Math.min(8388607, Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)));
      view.setUint8(offset, v & 0xff);
      view.setUint8(offset + 1, (v >> 8) & 0xff);
      view.setUint8(offset + 2, (v >> 16) & 0xff);
      offset += 3;
    } else {
      view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      offset += 2;
    }
  }
  return out;
}

/** Total byte length of a WAV file for `sampleCount` mono samples. */
export function wavByteLength(sampleCount: number, channels = 1, bitDepth: WavBitDepth = 16): number {
  return WAV_HEADER_BYTES + Math.ceil((sampleCount * channels * bitDepth) / 8);
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Decode a PCM WAV buffer (8/16/24/32-bit, mono or stereo) into mono Float32 samples.
 * Deliberately dependency-free so it runs identically in Node and the browser.
 */
export function decodeWav(buffer: ArrayBuffer | Uint8Array): { samples: Float32Array; sampleRate: number } {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new Error("Buffer too small to be a WAV file");
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let pos = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= bytes.byteLength) {
    const id = readAscii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true) || 1;
      sampleRate = view.getUint32(body + 4, true) || 44100;
      bits = view.getUint16(body + 14, true) || 16;
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, bytes.byteLength - body);
      break;
    }
    pos = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error("WAV file has no data chunk");
  if (audioFormat === 3) throw new Error("32-bit float WAV is not supported by this decoder");

  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataOffset + (i * channels + c) * bytesPerSample;
      sum += readSample(view, off, bits);
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

function readSample(view: DataView, offset: number, bits: number): number {
  if (bits === 8) return (view.getUint8(offset) - 128) / 128;
  if (bits === 16) return view.getInt16(offset, true) / 32768;
  if (bits === 24) {
    const b0 = view.getUint8(offset);
    const b1 = view.getUint8(offset + 1);
    const b2 = view.getUint8(offset + 2);
    let v = (b2 << 16) | (b1 << 8) | b0;
    if (v & 0x800000) v -= 0x1000000;
    return v / 8388608;
  }
  if (bits === 32) return view.getInt32(offset, true) / 2147483648;
  return 0;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** Linear resampling (good enough for analysis + fingerprint query clips). */
export function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.floor(samples.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

/** Mix all channels down + normalise peak to `peak` (no-op when already quiet enough). */
export function normalize(samples: Float32Array, peak = 0.92): Float32Array {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > max) max = a;
  }
  if (max === 0) return samples;
  const gain = peak / max;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}
