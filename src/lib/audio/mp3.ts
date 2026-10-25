/**
 * MP3 encoding (LAME, pure JS) + a tiny ID3v2.3 writer.
 *
 * Why encode on the server? Every SongHub track is *generated*, so an MP3 is a
 * real render at a chosen sample rate and bitrate rather than a re-encode of a
 * master — 32 kbps for a data cap, 320 kbps for headphones, same source material.
 *
 * `@breezystack/lamejs` is a maintained build of lamejs (the original npm package
 * has a broken module graph and throws `MPEGMode is not defined`).
 */

import { Mp3Encoder } from "@breezystack/lamejs";

/** LAME wants 1152-sample granules per call. */
const GRANULE = 1152;

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export interface Mp3EncoderHandle {
  /** Encode a chunk of mono float samples. */
  push: (samples: Float32Array) => Uint8Array;
  /** Emit the final frames. */
  finish: () => Uint8Array;
}

/**
 * Stateful encoder: feed it audio in any chunk sizes, it re-blocks to LAME's
 * granule size. Used by both the download path (one big call) and the streaming
 * path (many small calls).
 */
export function createMp3Encoder(sampleRate: number, kbps: number): Mp3EncoderHandle {
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const pending: number[] = [];

  return {
    push(samples: Float32Array): Uint8Array {
      const int16 = floatToInt16(samples);
      for (let i = 0; i < int16.length; i++) pending.push(int16[i]);

      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (pending.length - offset >= GRANULE) {
        const block = Int16Array.from(pending.slice(offset, offset + GRANULE));
        const encoded = encoder.encodeBuffer(block);
        if (encoded.length) chunks.push(encoded);
        offset += GRANULE;
      }
      if (offset) pending.splice(0, offset);
      return concat(chunks);
    },
    finish(): Uint8Array {
      const chunks: Uint8Array[] = [];
      if (pending.length) {
        const block = Int16Array.from(pending);
        pending.length = 0;
        const encoded = encoder.encodeBuffer(block);
        if (encoded.length) chunks.push(encoded);
      }
      const tail = encoder.flush();
      if (tail.length) chunks.push(tail);
      return concat(chunks);
    },
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (!chunks.length) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Encode a complete mono track to MP3 in one pass. */
export function encodeMp3(samples: Float32Array, sampleRate: number, kbps: number): Uint8Array {
  const encoder = createMp3Encoder(sampleRate, kbps);
  return concat([encoder.push(samples), encoder.finish()]);
}

/* ------------------------------------------------------------- ID3v2.3 ----- */

export interface TrackTags {
  title: string;
  artist: string;
  album: string;
  year: number;
  genre?: string;
  comment?: string;
  bpm?: number;
}

/** One ID3v2.3 frame: 4-char id, big-endian size, 2 flag bytes, then the body. */
function frame(id: string, body: Buffer): Uint8Array {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, "latin1");
  header.writeUInt32BE(body.length, 4);
  header.writeUInt16BE(0, 8); // flags
  return new Uint8Array(Buffer.concat([header, body]));
}

/**
 * Text frames in ID3v2.3 are ISO-8859-1 (0) or UTF-16 + BOM (1). The Bollywood
 * collection carries Devanagari titles, so everything is written as UTF-16LE
 * with a BOM — every player we care about understands that.
 */
const BOM_LE = Buffer.from([0xff, 0xfe]);

function textFrame(id: string, value: string): Uint8Array {
  const body = Buffer.concat([Buffer.from([0x01]), BOM_LE, Buffer.from(value, "utf16le")]);
  return frame(id, body);
}

/** COMM needs a language code and a NUL-terminated description before the text. */
function commentFrame(value: string): Uint8Array {
  const body = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from("eng", "latin1"),
    BOM_LE,
    Buffer.from([0x00, 0x00]),
    BOM_LE,
    Buffer.from(value, "utf16le"),
  ]);
  return frame("COMM", body);
}

/** Syncsafe integer (7 bits per byte) used by the ID3v2 tag header. */
function syncSafe(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

/** Build a minimal, valid ID3v2.3 tag so the MP3 carries real metadata. */
export function buildId3Tag(tags: TrackTags): Uint8Array {
  const frames: Uint8Array[] = [
    textFrame("TIT2", tags.title),
    textFrame("TPE1", tags.artist),
    textFrame("TALB", tags.album),
    textFrame("TYER", String(tags.year)),
  ];
  if (tags.genre) frames.push(textFrame("TCON", tags.genre));
  if (tags.bpm) frames.push(textFrame("TBPM", String(Math.round(tags.bpm))));
  frames.push(textFrame("TSSE", "SongHub synth render · LAME"));
  if (tags.comment) frames.push(commentFrame(tags.comment));

  const body = Buffer.concat(frames.map((frame) => Buffer.from(frame)));
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([0x03, 0x00, 0x00]), syncSafe(body.length)]);
  return new Uint8Array(Buffer.concat([header, body]));
}

/** MP3 bytes with an ID3v2.3 tag prepended. */
export function wrapMp3(audio: Uint8Array, tags: TrackTags): Uint8Array {
  const tag = buildId3Tag(tags);
  const out = new Uint8Array(tag.length + audio.length);
  out.set(tag, 0);
  out.set(audio, tag.length);
  return out;
}
