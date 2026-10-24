import { NextResponse } from "next/server";
import { search } from "@/lib/ai/search";
import { getEvents, getLibrary, tasteProfileFrom } from "@/lib/store/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let query = "";
  let limit = 12;
  try {
    const body = (await request.json()) as { query?: string; limit?: number };
    query = body.query ?? "";
    if (body.limit) limit = Math.max(1, Math.min(50, body.limit));
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { query: string }" }, { status: 400 });
  }

  const [library, events] = await Promise.all([getLibrary(), getEvents()]);
  const result = search(query, { limit, tasteProfile: tasteProfileFrom(library, events) });
  return NextResponse.json(result);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 12)));
  const [library, events] = await Promise.all([getLibrary(), getEvents()]);
  return NextResponse.json(search(query, { limit, tasteProfile: tasteProfileFrom(library, events) }));
}
