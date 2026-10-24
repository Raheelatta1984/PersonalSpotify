import { NextResponse } from "next/server";
import { buildRadio, getEvents, getLibrary, tasteProfileFrom } from "@/lib/store/library";
import { TRACKS } from "@/lib/catalog/tracks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const seed = url.searchParams.get("seed");
  const limit = Math.max(1, Math.min(40, Number(url.searchParams.get("limit") ?? 20)));
  const [library, events] = await Promise.all([getLibrary(), getEvents()]);
  const taste = tasteProfileFrom(library, events);
  const tracks = buildRadio(seed, taste, limit);

  // "Made for you" rows: one per dominant taste cluster, newest first.
  const recentlyPlayed = library.recent.map((id) => TRACKS.find((t) => t.id === id)).filter(Boolean).slice(0, 8);
  return NextResponse.json({
    radio: tracks,
    seed: tracks[0]?.id ?? null,
    taste,
    recentlyPlayed,
    rows: [
      { title: "Made for you", tracks: tracks.slice(0, 8) },
      { title: "Because you like " + (taste.genres[0] ?? "everything"), tracks: TRACKS.filter((t) => t.genres.includes((taste.genres[0] ?? "electronic") as never)).slice(0, 8) },
      { title: "Fresh in your library", tracks: recentlyPlayed },
      { title: "Trending in SongHub", tracks: [...TRACKS].sort((a, b) => b.popularity - a.popularity).slice(0, 8) },
    ].filter((row) => row.tracks.length > 0),
  });
}
