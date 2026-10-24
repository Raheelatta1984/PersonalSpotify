import { NextResponse } from "next/server";
import { recordPlay, getEvents } from "@/lib/store/library";
import { getTrack } from "@/lib/catalog/tracks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCES = ["search", "home", "library", "radio", "playlist", "identify", "online", "queue"] as const;

export async function GET() {
  return NextResponse.json({ events: await getEvents() });
}

export async function POST(request: Request) {
  let body: { trackId?: string; msPlayed?: number; source?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.trackId) return NextResponse.json({ error: "trackId is required" }, { status: 400 });
  if (!getTrack(body.trackId)) return NextResponse.json({ error: "Unknown track" }, { status: 404 });

  const source = (SOURCES as readonly string[]).includes(body.source ?? "") ? (body.source as (typeof SOURCES)[number]) : "queue";
  const event = await recordPlay({
    trackId: body.trackId,
    msPlayed: Math.max(0, Math.min(body.msPlayed ?? 0, 24 * 3600 * 1000)),
    source,
  });
  return NextResponse.json(event, { status: 201 });
}
