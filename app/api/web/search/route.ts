import { NextResponse } from "next/server";
import { searchWeb } from "@/lib/online/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/web/search?q=daft+punk&limit=12
 * POST /api/web/search { query, limit?, siteOnly? }
 *
 * Searches mp3juice.sc and — when the site has nothing — the wider web.
 * Returns metadata plus each song's real page URL; audio is resolved on play.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.max(1, Math.min(24, Number(url.searchParams.get("limit") ?? 12)));
  const siteOnly = url.searchParams.get("siteOnly") === "true";
  return NextResponse.json(await searchWeb(query, { limit, allowFallback: !siteOnly }));
}

export async function POST(request: Request) {
  let body: { query?: string; limit?: number; siteOnly?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { query: string }" }, { status: 400 });
  }
  const query = (body.query ?? "").trim();
  const limit = Math.max(1, Math.min(24, body.limit ?? 12));
  return NextResponse.json(await searchWeb(query, { limit, allowFallback: body.siteOnly !== true }));
}
