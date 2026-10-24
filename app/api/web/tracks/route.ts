import { NextResponse } from "next/server";
import { clearWebAudio } from "@/lib/online/webstream";
import { deleteWebTrack, listWebTracks, listWebTracksAsTracks } from "@/lib/online/weblibrary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/web/tracks — every web song saved to playlists or played so far. */
export async function GET() {
  const [webTracks, tracks] = await Promise.all([listWebTracks(), listWebTracksAsTracks()]);
  return NextResponse.json({ webTracks, tracks, count: webTracks.length });
}

/** DELETE /api/web/tracks?id=web_abc — forget a saved web song (+ cached audio). */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const removed = await deleteWebTrack(id);
  if (!removed) return NextResponse.json({ error: "Unknown web track" }, { status: 404 });
  await clearWebAudio(id);
  return NextResponse.json({ ok: true, id });
}
