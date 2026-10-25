import { NextResponse } from "next/server";
import { TRACKS, ARTISTS, BOLLYWOOD_TRACKS } from "@/lib/catalog/tracks";
import { listWebTracks, listWebTracksAsTracks } from "@/lib/online/weblibrary";
import { ensureSeedPlaylists, getLibrary, tasteProfileFrom, getEvents } from "@/lib/store/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hand-curated shelves. The Bollywood shelf is the reason this endpoint now
 * ships collections: Hindi film music is a *browsing* need, not a search need.
 */
const COLLECTIONS = [
  {
    id: "col_bollywood-romance",
    title: "Bollywood romance",
    subtitle: "Rain, letters, and the long way home",
    accent: "#ff8a3d",
    trackIds: BOLLYWOOD_TRACKS.filter((t) => t.moods.includes("romantic")).map((t) => t.id),
  },
  {
    id: "col_bollywood-sangeet",
    title: "Sangeet night",
    subtitle: "Dhol, dholak and dance floors",
    accent: "#ff5c7a",
    trackIds: BOLLYWOOD_TRACKS.filter((t) => t.moods.includes("energetic")).map((t) => t.id),
  },
  {
    id: "col_sufi-ghazal",
    title: "Sufi & ghazal",
    subtitle: "Sitar, tabla, slow burn",
    accent: "#c9a0ff",
    trackIds: BOLLYWOOD_TRACKS.filter((t) => t.genres.includes("sufi")).map((t) => t.id),
  },
  {
    id: "col_barsaat",
    title: "Barsaat · monsoon hours",
    subtitle: "For the rain outside the window",
    accent: "#6fb1ff",
    trackIds: BOLLYWOOD_TRACKS.filter((t) => t.tags.includes("rain") || t.moods.includes("melancholic")).map((t) => t.id),
  },
];

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
    /** Curated shelves the UI renders directly (no extra round trip). */
    collections: COLLECTIONS,
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
