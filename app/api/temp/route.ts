import { NextResponse } from "next/server";
import { listTempDownloads, sweepExpired } from "@/lib/online/downloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await sweepExpired();
  const downloads = await listTempDownloads();
  return NextResponse.json({ downloads, count: downloads.length });
}
