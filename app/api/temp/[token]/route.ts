import { NextResponse } from "next/server";
import { deleteTempDownload, readTempBytes, getTempFile } from "@/lib/online/downloads";
import { parseRange } from "@/lib/audio/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const file = await getTempFile(token);
  if (!file) return NextResponse.json({ error: "Unknown or expired download token" }, { status: 404 });
  if (file.expired) {
    await deleteTempDownload(token);
    return NextResponse.json({ error: "This temporary download has expired" }, { status: 410 });
  }

  const payload = await readTempBytes(token);
  if (!payload) return NextResponse.json({ error: "Cached audio is missing" }, { status: 404 });

  const total = payload.bytes.byteLength;
  const range = parseRange(request.headers.get("range"), total);
  const headers: Record<string, string> = {
    "Content-Type": payload.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Expires-At": payload.expiresAt,
  };

  if (range) {
    const slice = payload.bytes.subarray(range.start, range.end + 1);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
      },
    });
  }

  return new Response(payload.bytes as unknown as BodyInit, {
    status: 200,
    headers: { ...headers, "Content-Length": String(total) },
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const removed = await deleteTempDownload(token);
  if (!removed) return NextResponse.json({ error: "Unknown token" }, { status: 404 });
  return NextResponse.json({ ok: true, token });
}
