import { NextResponse } from "next/server";
import { search } from "@/lib/ai/search";
import { createPlaylist, getEvents, getLibrary, tasteProfileFrom } from "@/lib/store/library";
import { understandQuery } from "@/lib/ai/understand";
import { clamp } from "@/lib/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { prompt: string, size?: number, save?: boolean }
 * Turns a natural-language brief into a playlist, with an explanation.
 */
export async function POST(request: Request) {
  let body: { prompt?: string; size?: number; save?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });

  // "40 minutes of focus music" -> derive the number of tracks from the request
  const minutesMatch = /(\d{1,3})\s*(?:min(?:ute)?s?|mins)\b/.exec(prompt);
  const requestedMinutes = minutesMatch ? Number(minutesMatch[1]) : null;
  const size = clamp(
    body.size ?? (requestedMinutes ? Math.round(requestedMinutes / 1.6) : 10),
    3,
    30,
  );
  const [library, events] = await Promise.all([getLibrary(), getEvents()]);
  const taste = tasteProfileFrom(library, events);
  const understanding = understandQuery(prompt, { tasteProfile: taste });
  const result = search(prompt, { limit: size, tasteProfile: taste });

  const name = derivePlaylistName(prompt, understanding.filters.genres ?? [], understanding.filters.moods ?? []);
  const playlist = body.save === false
    ? null
    : await createPlaylist({
        name,
        description: result.answer,
        trackIds: result.hits.map((h) => h.track.id),
        aiGenerated: true,
      });

  return NextResponse.json({
    prompt,
    name,
    description: result.answer,
    reasoning: understanding.reasoning,
    tracks: result.hits.map((h) => h.track),
    scores: result.hits.map((h) => ({ id: h.track.id, score: h.score, signals: h.signals, reasons: h.reasons })),
    savedPlaylist: playlist,
  });
}

function derivePlaylistName(prompt: string, genres: string[], moods: string[]): string {
  const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  if (moods.length && genres.length) return `${titleCase(moods[0])} ${titleCase(genres[0])}`;
  if (moods.length) return `${titleCase(moods[0])} Mix`;
  if (genres.length) return `${titleCase(genres[0])} Mix`;
  const words = prompt.split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(" ");
  return words ? titleCase(words) : "AI Mix";
}
