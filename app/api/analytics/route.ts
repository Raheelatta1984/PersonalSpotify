import { NextResponse } from "next/server";
import { getEvents, getLibrary, summariseAnalytics, tasteProfileFrom } from "@/lib/store/library";
import { listWebTracksAsTracks } from "@/lib/online/weblibrary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [events, library, webTracks] = await Promise.all([getEvents(), getLibrary(), listWebTracksAsTracks()]);
  const known = new Map(webTracks.map((track) => [track.id, track]));
  return NextResponse.json({
    summary: summariseAnalytics(events, library, known),
    taste: tasteProfileFrom(library, events),
    events: events.slice(-200),
  });
}
