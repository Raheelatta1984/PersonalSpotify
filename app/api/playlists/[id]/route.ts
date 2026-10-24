import { NextResponse } from "next/server";
import { deletePlaylist, updatePlaylist } from "@/lib/store/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { name?: string; description?: string; trackIds?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const playlist = await updatePlaylist(id, body);
  if (!playlist) return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  return NextResponse.json(playlist);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const removed = await deletePlaylist(id);
  if (!removed) return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
