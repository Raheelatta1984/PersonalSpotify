import { getTrack } from "@/lib/catalog/tracks";
import { geometryFor, parseRange, renderWavBytes, fullWavCached } from "@/lib/audio/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a track as a seekable WAV.
 *   GET /api/stream/trk_neon_overpass          -> 200 full file
 *   GET /api/stream/trk_neon_overpass (Range:) -> 206 partial content
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
