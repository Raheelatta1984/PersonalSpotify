import { getTrack } from "@/lib/catalog/tracks";
import { geometryFor, parseRange, renderWavBytes, fullWavCached } from "@/lib/audio/stream";
import { encodeTrackAudio, streamTrackMp3 } from "@/lib/audio/encode";
import { resolveQuality, DEFAULT_QUALITY, type AudioQuality } from "@/lib/audio/quality";
import type { Track } from "@/lib/types";
import { isWebTrackId } from "@/lib/online/weblibrary";
import { loadWebAudio } from "@/lib/online/webstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a track as a seekable audio file.
 *
 *   GET /api/stream/trk_neon_overpass                        -> 200 synth WAV (22.05 kHz)
 *   GET /api/stream/trk_neon_overpass?q=mp3-64                -> 64 kbps MP3, streamed as it renders
 *   GET /api/stream/trk_neon_overpass?q=mp3-320               -> 320 kbps / 48 kHz MP3
 *   GET /api/stream/trk_neon_overpass?q=wav-48&Range: ...     -> 206 partial WAV at 48 kHz
 *   GET /api/stream/web_abc123                                -> saved web song: licensed audio
 *                                                                when available, else a preview
 *
 * `q` accepts any id from `src/lib/audio/quality.ts` (MP3 32…320 kbps,
 * WAV 22.05/44.1/48 kHz at 16- or 24-bit). Without `q` the original
 * byte-range WAV path is used, which is what the built-in player defaults to.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const qualityParam = url.searchParams.get("q");

  if (isWebTrackId(id)) return serveWebSong(request, id);

  const track = getTrack(id);
  if (!track) return new Response("Track not found", { status: 404 });

  const quality = resolveQuality(qualityParam);
  if (qualityParam && !quality) {
    return new Response(`Unknown quality "${qualityParam}"`, { status: 400 });
  }
  if (quality) return serveAtQuality(request, track, quality);

  return serveDefaultWav(request, track);
}

/* ------------------------------------------------------- default (WAV) ---- */

function serveDefaultWav(request: Request, track: Track): Response {
  const geo = geometryFor(track);
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, geo.totalBytes);

  const baseHeaders: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "X-Song-Duration": geo.durationSec.toFixed(3),
    "X-Sample-Rate": String(geo.sampleRate),
    "X-Playback-Kind": "full",
    "X-Quality": DEFAULT_QUALITY,
  };

  if (rangeHeader && !range) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${geo.totalBytes}` },
    });
  }

  if (!range) {
    const bytes = fullWavCached(track);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(bytes.byteLength) },
    });
  }

  const bytes = renderWavBytes(track, range.start, range.end);
  return new Response(bytes as unknown as BodyInit, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Length": String(bytes.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${geo.totalBytes}`,
    },
  });
}

/* ------------------------------------------------- choose your quality ---- */

function qualityHeaders(quality: AudioQuality, track: Track): Record<string, string> {
  return {
    "X-Quality": quality.id,
    "X-Quality-Label": quality.label,
    "X-Audio-Format": quality.family,
    "X-Sample-Rate": String(quality.sampleRate),
    "X-Bitrate": quality.bitrateKbps ? String(quality.bitrateKbps) : "",
    "X-Data-Saver": String(quality.dataSaver),
    "X-Song-Duration": String(track.duration),
    "X-Playback-Kind": "full",
  };
}

async function serveAtQuality(request: Request, track: Track, quality: AudioQuality): Promise<Response> {
  const headers = qualityHeaders(quality, track);
  const rangeHeader = request.headers.get("range");

  /* WAV rungs stay byte-range addressable: the virtual file is a pure function
     of time, so a seek costs the same as the first second. */
  if (quality.family === "wav") {
    const bitDepth = quality.bitDepth ?? 16;
    const geo = geometryFor(track, quality.sampleRate, bitDepth);
    const range = parseRange(rangeHeader, geo.totalBytes);
    const type = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" };

    if (rangeHeader && !range) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...headers, ...type, "Content-Range": `bytes */${geo.totalBytes}` },
      });
    }
    if (range) {
      const bytes = renderWavBytes(track, range.start, range.end, quality.sampleRate, bitDepth);
      return new Response(bytes as unknown as BodyInit, {
        status: 206,
        headers: {
          ...headers,
          ...type,
          "Content-Length": String(bytes.byteLength),
          "Content-Range": `bytes ${range.start}-${range.end}/${geo.totalBytes}`,
        },
      });
    }
    // Full file: render once and cache it (these are big, so keep the LRU honest).
    const encoded = encodeTrackAudio(track, quality);
    return new Response(encoded.bytes as unknown as BodyInit, {
      status: 200,
      headers: { ...headers, ...type, "Content-Length": String(encoded.bytes.byteLength) },
    });
  }

  /* MP3: stream the encode so the player starts before the render finishes. */
  if (!rangeHeader) {
    const stream = streamTrackMp3(track, quality);
    return new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "audio/mpeg",
        // The body length is unknown up front, so browsers must not try ranges.
        "Cache-Control": "public, max-age=3600",
        "X-Streamed": "true",
      },
    });
  }

  // A range request needs a known length, so finish the encode first.
  const encoded = encodeTrackAudio(track, quality);
  const total = encoded.bytes.byteLength;
  const range = parseRange(rangeHeader, total);
  const type = { "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" };
  if (!range) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { ...headers, ...type, "Content-Range": `bytes */${total}` },
    });
  }
  const slice = encoded.bytes.subarray(range.start, range.end + 1);
  return new Response(slice as unknown as BodyInit, {
    status: 206,
    headers: {
      ...headers,
      ...type,
      "Content-Length": String(slice.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
    },
  });
}

/* ------------------------------------------------------------ web songs --- */

async function serveWebSong(request: Request, id: string): Promise<Response> {
  const audio = await loadWebAudio(id);
  if (!audio) return new Response("Web track not found", { status: 404 });

  const total = audio.bytes.byteLength;
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, total);

  const headers: Record<string, string> = {
    "Content-Type": audio.contentType,
    "Accept-Ranges": "bytes",
    // The cached copy is disposable and may be replaced by a new resolution.
    "Cache-Control": "no-store",
    "X-Playback-Kind": audio.playbackKind,
    "X-Audio-Cached": String(audio.cached),
    // Web audio is already encoded by its publisher; the ladder is for synth tracks.
    "X-Quality": "source",
  };

  if (rangeHeader && !range) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${total}` },
    });
  }

  if (range) {
    const slice = audio.bytes.subarray(range.start, range.end + 1);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
      },
    });
  }

  return new Response(audio.bytes as unknown as BodyInit, {
    status: 200,
    headers: { ...headers, "Content-Length": String(total) },
  });
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const quality = resolveQuality(url.searchParams.get("q"));

  if (isWebTrackId(id)) {
    const audio = await loadWebAudio(id);
    if (!audio) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": audio.contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(audio.bytes.byteLength),
        "X-Playback-Kind": audio.playbackKind,
      },
    });
  }

  const track = getTrack(id);
  if (!track) return new Response(null, { status: 404 });

  if (quality) {
    const headers = qualityHeaders(quality, track);
    if (quality.family === "wav") {
      const geo = geometryFor(track, quality.sampleRate, quality.bitDepth ?? 16);
      return new Response(null, {
        status: 200,
        headers: { ...headers, "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": String(geo.totalBytes) },
      });
    }
    return new Response(null, {
      status: 200,
      headers: { ...headers, "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes" },
    });
  }

  const geo = geometryFor(track);
  return new Response(null, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": String(geo.totalBytes),
      "X-Quality": DEFAULT_QUALITY,
    },
  });
}
