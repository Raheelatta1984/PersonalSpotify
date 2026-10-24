import { NextResponse } from "next/server";
import { decodeRequestBody, identifyClip } from "@/lib/audio/identify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Identify a clip.
 *   POST /api/identify        body: raw little-endian int16 PCM
 *                             header: x-sample-rate (default 8000)
 *   POST /api/identify        body: a WAV file (Content-Type: audio/wav)
 */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  let samples: Float32Array;
  let sampleRate: number;

  try {
    if (contentType.includes("multipart/form-data")) {
      // NB: read the multipart body exactly once — consuming arrayBuffer() first
      // would make formData() throw "Body has already been read".
      const form = await request.formData();
      const file = form.get("audio");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "multipart body needs an `audio` file field" }, { status: 400 });
      }
      if (file.size === 0) return NextResponse.json({ error: "The uploaded audio file is empty" }, { status: 400 });
      if (file.size > 32 * 1024 * 1024) {
        return NextResponse.json({ error: "Clip too large (max 32 MB)" }, { status: 413 });
      }
      const decoded = decodeRequestBody(Buffer.from(await file.arrayBuffer()), 8000);
      samples = decoded.samples;
      sampleRate = decoded.sampleRate;
    } else {
      const buffer = Buffer.from(await request.arrayBuffer());
      if (!buffer.byteLength) {
        return NextResponse.json({ error: "Empty body — send PCM or WAV audio" }, { status: 400 });
      }
      if (buffer.byteLength > 32 * 1024 * 1024) {
        return NextResponse.json({ error: "Clip too large (max 32 MB)" }, { status: 413 });
      }
      const headerRate = Number(request.headers.get("x-sample-rate") ?? 0);
      const decoded = decodeRequestBody(buffer, headerRate || 8000);
      samples = decoded.samples;
      sampleRate = decoded.sampleRate;
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read clip" }, { status: 400 });
  }

  const result = await identifyClip(samples, sampleRate, { limit: 5 });
  return NextResponse.json(result);
}

export async function GET() {
  return NextResponse.json({
    usage:
      "POST raw int16 PCM with header x-sample-rate, or a WAV file. The browser captures with the mic, decodes with Web Audio, downsamples to 8 kHz mono and posts the PCM here.",
    minSeconds: 1.2,
    maxSeconds: 30,
  });
}
