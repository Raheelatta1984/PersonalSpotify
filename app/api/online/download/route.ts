import { NextResponse } from "next/server";
import { lookupOnlineResult, searchOnline } from "@/lib/online/sources";
import { prepareTempDownload, sweepExpired } from "@/lib/online/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { resultId: string, query?: string, ttlSeconds?: number } -> TempDownload */
export async function POST(request: Request) {
  let body: { resultId?: string; query?: string; ttlSeconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.resultId) return NextResponse.json({ error: "resultId is required" }, { status: 400 });

  await sweepExpired();

  const result = await lookupOnlineResult(body.resultId, body.query);
  if (!result) return NextResponse.json({ error: `Unknown result ${body.resultId}` }, { status: 404 });

  const download = await prepareTempDownload(result, { ttlSeconds: body.ttlSeconds });
  return NextResponse.json(download, { status: 201 });
}
