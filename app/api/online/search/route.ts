import { NextResponse } from "next/server";
import { searchOnline } from "@/lib/online/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let query = "";
  let limit = 8;
  try {
    const body = (await request.json()) as { query?: string; limit?: number };
    query = (body.query ?? "").trim();
    if (body.limit) limit = Math.max(1, Math.min(20, body.limit));
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { query: string }" }, { status: 400 });
  }
  const outcome = await searchOnline(query, limit);
  return NextResponse.json(outcome);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") ?? 8)));
  return NextResponse.json(await searchOnline(query, limit));
}
