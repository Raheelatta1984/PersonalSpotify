import { NextResponse } from "next/server";
import { browseUrl, lookupOnlineResult, offlineDocument } from "@/lib/online/sources";

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

  // Resolve through the shared lookup so demo ids still work when the live
  // catalogues *are* reachable (otherwise the id vanishes from the live result set).
  const result = await lookupOnlineResult(id, body.query);
  if (!result) return NextResponse.json({ error: `Unknown result ${id}` }, { status: 404 });

  if (result.source === "local-web" || id.startsWith("local-web:")) {
    return NextResponse.json(offlineDocument(result));
  }
  return NextResponse.json(await browseUrl(result.sourceUrl, result));
}
