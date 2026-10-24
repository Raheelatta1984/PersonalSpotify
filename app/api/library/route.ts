import { NextResponse } from "next/server";
import { getLibrary, toggleLike, getPlaylists } from "@/lib/store/library";
import { listWebTracksAsTracks, resolvePlayableTracks } from "@/lib/online/weblibrary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [library, playlists, webTracks] = await Promise.all([getLibrary(), getPlaylists(), listWebTracksAsTracks()]);
  return NextResponse.json({
    ...library,
    // resolve catalog ids *and* saved `web_…` ids
    likedTracks: await resolvePlayableTracks(library.liked),
    recentTracks: await resolvePlayableTracks(library.recent),
    webTracks,
    playlists,
  });
}

export async function POST(request: Request) {
  let body: { action?: string; trackId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (body.action !== "toggle-like" || !body.trackId) {
    return NextResponse.json({ error: "Expected { action: 'toggle-like', trackId }" }, { status: 400 });
  }
  const result = await toggleLike(body.trackId).catch(() => null);
  if (!result) return NextResponse.json({ error: "Unknown track" }, { status: 404 });
  return NextResponse.json({ liked: result.liked, likedCount: result.library.liked.length });
}
