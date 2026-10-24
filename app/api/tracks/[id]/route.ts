import { NextResponse } from "next/server";
import { getTrack } from "@/lib/catalog/tracks";
import { similarTracks } from "@/lib/ai/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const track = getTrack(id);
  if (!track) return NextResponse.json({ error: `No track with id ${id}` }, { status: 404 });
  return NextResponse.json({
    track,
    similar: similarTracks(id, 8),
    streamUrl: `/api/stream/${id}`,
  });
}
