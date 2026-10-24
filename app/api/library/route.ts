import { NextResponse } from "next/server";
import { getLibrary, toggleLike, getPlaylists } from "@/lib/store/library";
import { getTrack } from "@/lib/catalog/tracks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [library, playlists] = await Promise.all([getLibrary(), getPlaylists()]);
  return NextResponse.json({
    ...library,
    likedTracks: library.liked.map((id) => getTrack(id)).filter(Boolean),
    recentTracks: library.recent.map((id) => getTrack(id)).filter(Boolean),
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
  if (!getTrack(body.trackId)) return NextResponse.json({ error: "Unknown track" }, { status: 404 });
  const result = await toggleLike(body.trackId);
  return NextResponse.json({ liked: result.liked, likedCount: result.library.liked.length });
}
