import { NextResponse } from "next/server";
import { TRACKS, ARTISTS } from "@/lib/catalog/tracks";
import { listWebTracks, listWebTracksAsTracks } from "@/lib/online/weblibrary";
import { ensureSeedPlaylists, getLibrary, tasteProfileFrom, getEvents } from "@/lib/store/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includePlaylists = url.searchParams.get("playlists") !== "false";

  const [playlists, library, events, webTracks, webTracksAsTracks] = await Promise.all([
    includePlaylists ? ensureSeedPlaylists() : Promise.resolve([]),
    getLibrary(),
    getEvents(),
    listWebTracks(),
    listWebTracksAsTracks(),
  ]);

  return NextResponse.json({
    tracks: TRACKS,
    /** Songs imported from the web, already adapted to the Track shape. */
    webTracks: webTracksAsTracks,
    webTrackRecords: webTracks,
    artists: ARTISTS,
    playlists,
    library,
    taste: tasteProfileFrom(library, events),
    stats: {
      tracks: TRACKS.length,
      artists: ARTISTS.length,
      playlists: playlists.length,
      totalMinutes: Math.round(TRACKS.reduce((sum, t) => sum + t.duration, 0) / 60),
    },
  });
}
