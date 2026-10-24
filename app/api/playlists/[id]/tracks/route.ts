import { NextResponse } from "next/server";
import type { WebSearchHit } from "@/lib/types";
import { addTrackToPlaylist } from "@/lib/store/library";
import { resolvePlayableTracks, saveWebHit, webTrackToTrack } from "@/lib/online/weblibrary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/playlists/:id/tracks — append a track to a playlist.
 *   { trackId: "trk_…" }   catalog track
 *   { trackId: "web_…" }   previously saved web song
 *   { hit: WebSearchHit }  save the web song (real title + song URL) and append it
 *
 * Response includes `savedTitle` and `savedSourceUrl` so the UI can confirm
 * exactly what was stored.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { trackId?: string; hit?: WebSearchHit };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  let trackId = body.trackId;
  let webTrack: Awaited<ReturnType<typeof saveWebHit>> | null = null;

  if (!trackId && body.hit) {
    try {
      webTrack = await saveWebHit(body.hit);
      trackId = webTrack.id;
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not save that song" },
        { status: 400 },
      );
    }
  }

  if (!trackId) return NextResponse.json({ error: "trackId or hit is required" }, { status: 400 });

  const result = await addTrackToPlaylist(id, trackId);
  if (!result) return NextResponse.json({ error: "Playlist or track not found" }, { status: 404 });

  const track = webTrack ? webTrackToTrack(webTrack) : (await resolvePlayableTracks([trackId]))[0];
  return NextResponse.json(
    {
      playlist: result.playlist,
      added: result.added,
      track,
      webTrack,
      savedTitle: track?.title,
      savedSourceUrl: track?.web?.sourceUrl,
    },
    { status: result.added ? 201 : 200 },
  );
}
