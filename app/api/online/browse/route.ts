import { NextResponse } from "next/server";
import { browseUrl, offlineDocument, searchOnline } from "@/lib/online/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { url?: string, resultId?: string, query?: string } -> BrowseDocument */
export async function POST(request: Request) {
  let body: { url?: string; resultId?: string; query?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (body.url && !body.url.startsWith("songhub://")) {
    // Only http(s) browsing; anything else is rejected rather than fetched.
    if (!/^https?:\/\//i.test(body.url)) {
      return NextResponse.json({ error: "Only http(s) URLs can be opened" }, { status: 400 });
    }
    const doc = await browseUrl(body.url);
    return NextResponse.json(doc);
  }

  const id = body.resultId ?? (body.url ? body.url.replace("songhub://web/", "local-web:") : undefined);
  if (!id) return NextResponse.json({ error: "Provide url, resultId or query" }, { status: 400 });

  if (id.startsWith("local-web:")) {
    const outcome = await searchOnline(body.query ?? id.replace("local-web:", ""), 12);
    const result = outcome.results.find((r) => r.id === id);
    if (!result) return NextResponse.json({ error: `Unknown result ${id}` }, { status: 404 });
    return NextResponse.json(offlineDocument(result));
  }

  const outcome = await searchOnline(body.query ?? id.split(":").pop() ?? id, 12);
  const result = outcome.results.find((r) => r.id === id);
  if (!result) return NextResponse.json({ error: `Unknown result ${id}` }, { status: 404 });
  if (!outcome.live) return NextResponse.json(offlineDocument(result));
  return NextResponse.json(await browseUrl(result.sourceUrl, result));
}
