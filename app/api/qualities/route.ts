import { NextResponse } from "next/server";
import { getTrack } from "@/lib/catalog/tracks";
import {
  DEFAULT_QUALITY,
  QUALITIES,
  TIER_LABELS,
  VIDEO_QUALITIES,
  dataSaving,
  estimateBytes,
  estimateVideoBytes,
  formatBytes,
} from "@/lib/audio/quality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The quality ladder, with real size estimates for a specific song.
 *
 *   GET /api/qualities                       -> every rung (no song context)
 *   GET /api/qualities?id=trk_pyaar_ka_shor  -> rungs annotated with MB + savings
 *
 * The UI uses this to show "64 kbps · 0.5 MB · saves 80% data" next to each
 * option instead of making the user guess what "low quality" means.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const track = id ? getTrack(id) : undefined;
  if (id && !track) return NextResponse.json({ error: `Unknown track: ${id}` }, { status: 404 });

  const seconds = track?.duration ?? 180;

  const audio = QUALITIES.map((quality) => ({
    id: quality.id,
    family: quality.family,
    tier: quality.tier,
    tierLabel: TIER_LABELS[quality.tier],
    label: quality.label,
    short: quality.short,
    sampleRate: quality.sampleRate,
    bitrateKbps: quality.bitrateKbps,
    bitDepth: quality.bitDepth,
    dataSaver: quality.dataSaver,
    note: quality.note,
    bytes: estimateBytes(seconds, quality),
    size: formatBytes(estimateBytes(seconds, quality)),
    dataSaving: Math.round(dataSaving(quality) * 100),
    streamUrl: track ? `/api/stream/${track.id}?q=${quality.id}` : undefined,
    downloadUrl: track ? `/api/download/${track.id}?q=${quality.id}` : undefined,
  }));

  const video = VIDEO_QUALITIES.map((v) => ({
    id: v.id,
    label: v.label,
    width: v.width,
    height: v.height,
    fps: v.fps,
    videoKbps: v.videoKbps,
    heavy: v.heavy,
    note: v.note,
    bytes: estimateVideoBytes(seconds, v),
    size: formatBytes(estimateVideoBytes(seconds, v)),
  }));

  return NextResponse.json({
    default: DEFAULT_QUALITY,
    durationSec: seconds,
    track: track ? { id: track.id, title: track.title, artist: track.artist, duration: track.duration } : null,
    audio,
    video,
    /** MP4 export runs in the browser (WebCodecs); the server never encodes video. */
    videoExport: { clientSide: true, requires: "WebCodecs (Chrome/Edge 94+, Safari 16.4+)" },
  });
}
