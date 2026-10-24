import { NextResponse } from "next/server";
import { getEvents, getLibrary, summariseAnalytics, tasteProfileFrom } from "@/lib/store/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [events, library] = await Promise.all([getEvents(), getLibrary()]);
  return NextResponse.json({
    summary: summariseAnalytics(events, library),
    taste: tasteProfileFrom(library, events),
    events: events.slice(-200),
  });
}
