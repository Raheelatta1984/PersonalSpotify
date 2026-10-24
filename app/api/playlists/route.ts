import { NextResponse } from "next/server";
import { createPlaylist, ensureSeedPlaylists } from "@/lib/store/library";
import { filterPlayableIds } from "@/lib/online/weblibrary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ playlists: await ensureSeedPlaylists() });
}

export async function POST(request: Request) {
  let body: { name?: string; description?: string; trackIds?: string[]; aiGenerated?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.name || !body.name.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const trackIds = await filterPlayableIds(body.trackIds ?? []);
  const playlist = await createPlaylist({
    name: body.name,
    description: body.description,
    trackIds,
    aiGenerated: body.aiGenerated,
  });
  return NextResponse.json(playlist, { status: 201 });
}
