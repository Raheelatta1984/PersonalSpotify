import { getTrack } from "@/lib/catalog/tracks";
import { encodeTrackAudio, downloadFileName } from "@/lib/audio/encode";
import { qualityOr } from "@/lib/audio/quality";
import { isWebTrackId, getWebTrack } from "@/lib/online/weblibrary";
import { loadWebAudio } from "@/lib/online/webstream";
import { recordPlay } from "@/lib/store/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download a song at a chosen quality.
 *
 *   GET /api/download/trk_pyaar_ka_shor?q=mp3-64    -> "Saanjh Collective - Pyaar Ka Shor - 64kbps.mp3"
 *   GET /api/download/trk_pyaar_ka_shor?q=wav-48-24 -> 48 kHz / 24-bit WAV
 *   GET /api/download/web_abc123                    -> the saved web song's own file
 *
 * The bytes are identical to what `/api/stream/<id>?q=` serves: a real render at
 * that sample rate and bitrate, with an ID3v2.3 tag written for MP3s.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const quality = qualityOr(url.searchParams.get("q"));

  if (isWebTrackId(id)) return downloadWebTrack(id);

  const track = getTrack(id);
  if (!track) return Response.json({ error: `Unknown track: ${id}` }, { status: 404 });

  const encoded = encodeTrackAudio(track, quality);
  // A download is a play intent too — analytics should see it.
  await recordPlay({ trackId: track.id, msPlayed: 0, source: "online" });

  return new Response(encoded.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": encoded.contentType,
      "Content-Length": String(encoded.bytes.byteLength),
      "Content-Disposition": contentDisposition(downloadFileName(track, quality)),
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Quality": quality.id,
      "X-Quality-Label": quality.label,
      "X-Audio-Format": quality.family,
      "X-Sample-Rate": String(quality.sampleRate),
      "X-Cache-Hit": String(encoded.cached),
    },
  });
}

async function downloadWebTrack(id: string): Promise<Response> {
  const web = await getWebTrack(id);
  const audio = await loadWebAudio(id);
  if (!web || !audio) return Response.json({ error: `Unknown web track: ${id}` }, { status: 404 });

  const extension = audio.contentType.includes("mpeg")
    ? "mp3"
    : audio.contentType.includes("wav")
      ? "wav"
      : audio.contentType.includes("mp4")
        ? "m4a"
        : "audio";
  const safe = (value: string) => value.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
  const name = `${safe(web.artist)} - ${safe(web.title)}.${extension}`;

  return new Response(audio.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": audio.contentType,
      "Content-Length": String(audio.bytes.byteLength),
      "Content-Disposition": contentDisposition(name),
      "Cache-Control": "private, max-age=0, must-revalidate",
      // The publisher's own encoding — the ladder does not apply to web audio.
      "X-Quality": "source",
      "X-Audio-Format": extension,
    },
  });
}

/** RFC 5987 filename: ASCII fallback plus UTF-8 for Devanagari titles. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
