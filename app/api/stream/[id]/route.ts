import { getTrack } from "@/lib/catalog/tracks";
import { geometryFor, parseRange, renderWavBytes, fullWavCached } from "@/lib/audio/stream";
import { isWebTrackId } from "@/lib/online/weblibrary";
import { loadWebAudio } from "@/lib/online/webstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a track as a seekable audio file.
 *   GET /api/stream/trk_neon_overpass          -> 200 full synth WAV
 *   GET /api/stream/trk_neon_overpass (Range:) -> 206 partial content
 *   GET /api/stream/web_abc123                 -> saved web song: licensed audio
 *                                                 when available, else a preview
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (isWebTrackId(id)) return serveWebSong(request, id);

  const track = getTrack(id);
  if (!track) return new Response("Track not found", { status: 404 });

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

export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

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
  const geo = geometryFor(track);
  return new Response(null, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": String(geo.totalBytes),
    },
  });
}
