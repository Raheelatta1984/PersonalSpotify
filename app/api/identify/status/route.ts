import { NextResponse } from "next/server";
import { getIndexState, warmFingerprintIndex } from "@/lib/audio/identify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  warmFingerprintIndex();
  return NextResponse.json(getIndexState());
}
