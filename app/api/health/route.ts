import { NextResponse } from "next/server";
import { TRACKS, ARTISTS } from "@/lib/catalog/tracks";
import { getIndexState, warmFingerprintIndex } from "@/lib/audio/identify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Kick off the fingerprint build in the background so "identify" is warm.
  warmFingerprintIndex();
  const index = getIndexState();
  return NextResponse.json({
    ok: true,
    app: "SongHub",
    version: "1.0.0",
    time: new Date().toISOString(),
    catalog: { tracks: TRACKS.length, artists: ARTISTS.length },
    fingerprintIndex: index,
    features: {
      aiSearch: true,
      listenAndIdentify: true,
      inAppBrowser: true,
      tempDownloads: true,
      analytics: true,
      webMusic: true,
      webPlaylists: true,
    },
  });
}
