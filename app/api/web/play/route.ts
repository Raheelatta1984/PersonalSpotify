import { NextResponse } from "next/server";
import type { WebSearchHit } from "@/lib/types";
import { saveWebHit, webTrackToTrack } from "@/lib/online/weblibrary";
import { searchWeb } from "@/lib/online/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function validHit(hit: Partial<WebSearchHit> | undefined): hit is WebSearchHit {
  return Boolean(
    hit &&
      typeof hit.title === "string" &&
      hit.title.trim() &&
      typeof hit.sourceUrl === "string" &&
      /^(https?:\/\/|songhub:\/\/)/i.test(hit.sourceUrl),
  );
}

/**
 * POST /api/web/play
 *   { hit: WebSearchHit }            -> save + resolve audio for that row
 *   { resultId: string, query?: string } -> re-run the search and play the row
 *
 * Response: { webTrack, track, streamUrl }
 * The returned `track` is a normal player track whose `/api/stream/<id>` URL
 * serves the resolved audio (or a labelled synth preview).
 */
export async function POST(request: Request) {
  let body: { hit?: Partial<WebSearchHit>; resultId?: string; query?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  let hit = body.hit;
  if (!validHit(hit)) {
    if (!body.resultId) return NextResponse.json({ error: "A hit or resultId is required" }, { status: 400 });
    const outcome = await searchWeb(body.query ?? "", { limit: 24 });
    hit = outcome.hits.find((candidate) => candidate.id === body.resultId);
    if (!validHit(hit)) return NextResponse.json({ error: `Unknown result ${body.resultId}` }, { status: 404 });
  }

  try {
    const webTrack = await saveWebHit(hit);
    return NextResponse.json(
      {
        webTrack,
        track: webTrackToTrack(webTrack),
        streamUrl: `/api/stream/${webTrack.id}`,
        playbackKind: webTrack.playbackKind,
        license: webTrack.license,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve this song" }, { status: 400 });
  }
}
