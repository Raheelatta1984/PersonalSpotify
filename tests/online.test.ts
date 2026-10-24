import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  browseUrl,
  htmlToDocument,
  lookupOnlineResult,
  offlineDocument,
  offlineResults,
  searchOnline,
} from "@/lib/online/sources";
import { TRACKS } from "@/lib/catalog/tracks";

describe("providers", () => {
  it("declares at least three providers", () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(3);
  });
  it("has unique ids", () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
  });
  it("documents a license for each provider", () => {
    for (const provider of PROVIDERS) expect(provider.license.length).toBeGreaterThan(3);
  });
  it("marks Jamendo as needing a key", () => {
    expect(PROVIDERS.find((p) => p.id === "jamendo")?.requiresKey).toBe(true);
  });
  it("has an offline demo provider", () => {
    expect(PROVIDERS.some((p) => p.id === "local-web")).toBe(true);
  });
});

describe("offline results", () => {
  it("returns results without network access", () => {
    expect(offlineResults("neon overpass", 5).length).toBeGreaterThan(0);
  });
  it("is deterministic", () => {
    expect(offlineResults("rain", 5).map((r) => r.id)).toEqual(offlineResults("rain", 5).map((r) => r.id));
  });
  it("respects the limit", () => {
    expect(offlineResults("music", 3)).toHaveLength(3);
  });
  it("ranks a title match first", () => {
    expect(offlineResults("golden hour", 3)[0].title).toBe("Golden Hour");
  });
  it("produces fully-formed results", () => {
    for (const result of offlineResults("calm", 4)) {
      expect(result.id).toContain("local-web:");
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.artist.length).toBeGreaterThan(0);
      expect(result.sourceUrl).toContain("songhub://");
      expect(result.downloadable).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
  it("labels every result as demo data", () => {
    for (const result of offlineResults("jazz", 4)) expect(result.notes).toMatch(/offline demo/i);
  });
  it("handles gibberish gracefully", () => {
    expect(offlineResults("zzzzqqqq", 3).length).toBe(3);
  });
  it("handles an empty query", () => {
    expect(Array.isArray(offlineResults("", 3))).toBe(true);
  });
});

describe("searchOnline", () => {
  it("returns an outcome shape even when offline", async () => {
    const outcome = await searchOnline("neon harbor", 4);
    expect(outcome.query).toBe("neon harbor");
    expect(Array.isArray(outcome.results)).toBe(true);
    expect(outcome.providers.length).toBeGreaterThan(0);
    expect(typeof outcome.live).toBe("boolean");
    expect(outcome.tookMs).toBeGreaterThanOrEqual(0);
  }, 20000);

  it("explains itself when falling back", async () => {
    const outcome = await searchOnline("aurora drive", 3);
    if (!outcome.live) expect(outcome.notice ?? "").toMatch(/demo|unreachable|No live/i);
  }, 20000);

  it("returns an empty result set for an empty query", async () => {
    const outcome = await searchOnline("   ", 3);
    expect(outcome.results).toEqual([]);
    expect(outcome.notice).toBeTruthy();
  });

  it("de-duplicates repeated results", async () => {
    const outcome = await searchOnline("rain", 6);
    const keys = outcome.results.map((r) => `${r.title}|${r.artist}`.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  }, 20000);

  it("reports per-provider timing", async () => {
    const outcome = await searchOnline("glass aster", 3);
    for (const provider of outcome.providers) expect(provider.tookMs).toBeGreaterThanOrEqual(0);
  }, 20000);
});

describe("lookupOnlineResult", () => {
  it("finds a local demo result by id", async () => {
    const first = offlineResults("neon", 3)[0];
    const found = await lookupOnlineResult(first.id, "neon");
    expect(found?.id).toBe(first.id);
  });
  it("returns null for a malformed id", async () => {
    expect(await lookupOnlineResult("nonsense")).toBeNull();
  });
  it("returns null for an unknown local result", async () => {
    expect(await lookupOnlineResult("local-web:does-not-exist", "nothing")).toBeNull();
  });
});

describe("htmlToDocument", () => {
  const html = `
    <html><head>
      <title>Neon Overpass — Neon Harbor</title>
      <meta name="description" content="A synthwave track about night driving." />
    </head><body>
      <h1>Neon Overpass</h1>
      <p>Released in 2023 on Coastal Signal.</p>
      <h2>Listen</h2>
      <audio src="/audio/neon.mp3"></audio>
      <ul><li>Synthwave</li><li>Instrumental</li></ul>
      <a href="https://example.org/artist">Neon Harbor</a>
      <img src="/cover.jpg" />
      <script>console.log("ignore me")</script>
      <style>.x{color:red}</style>
    </body></html>`;

  const doc = htmlToDocument("https://example.org/track/neon", html, true);

  it("extracts the title", () => {
    expect(doc.title).toContain("Neon Overpass");
  });
  it("extracts the description", () => {
    expect(doc.description).toContain("synthwave");
  });
  it("extracts headings", () => {
    expect(doc.blocks.some((b) => b.type === "heading" && b.text === "Neon Overpass")).toBe(true);
  });
  it("extracts paragraphs", () => {
    expect(doc.blocks.some((b) => b.text?.includes("Coastal Signal"))).toBe(true);
  });
  it("strips scripts and styles", () => {
    expect(doc.blocks.every((b) => !b.text?.includes("console.log"))).toBe(true);
    expect(doc.blocks.every((b) => !b.text?.includes("color:red"))).toBe(true);
  });
  it("absolutises audio sources", () => {
    const audio = doc.blocks.find((b) => b.type === "audio");
    expect(audio?.src).toBe("https://example.org/audio/neon.mp3");
  });
  it("absolutises images", () => {
    const image = doc.blocks.find((b) => b.type === "image");
    expect(image?.src).toBe("https://example.org/cover.jpg");
  });
  it("collects links", () => {
    expect(doc.links.some((l) => l.href === "https://example.org/artist")).toBe(true);
  });
  it("marks live documents", () => {
    expect(doc.fetchedLive).toBe(true);
  });
  it("records the source host", () => {
    expect(doc.source).toBe("example.org");
  });
  it("decodes html entities", () => {
    const withEntities = htmlToDocument("https://x.test", "<title>A &amp; B</title><p>Caf&#233; &quot;quoted&quot;</p>", false);
    expect(withEntities.title).toBe("A & B");
    expect(withEntities.blocks[0].text).toContain("Café");
  });
  it("falls back to raw text for unstructured pages", () => {
    const plain = htmlToDocument("https://x.test", "<div>just some words here</div>", false);
    expect(plain.blocks.length).toBeGreaterThan(0);
  });
  it("handles an empty document", () => {
    const empty = htmlToDocument("https://x.test", "", false);
    expect(empty.title).toBe("https://x.test");
  });
  it("caps the number of blocks", () => {
    const many = `<html><body>${"<p>paragraph</p>".repeat(500)}</body></html>`;
    expect(htmlToDocument("https://x.test", many, false).blocks.length).toBeLessThanOrEqual(60);
  });
  it("marks non-live documents", () => {
    expect(htmlToDocument("https://x.test", "<p>hi</p>", false).fetchedLive).toBe(false);
  });
});

describe("offlineDocument", () => {
  const result = offlineResults("neon overpass", 1)[0];
  const doc = offlineDocument(result);

  it("produces a title and blocks", () => {
    expect(doc.title).toBe(result.title);
    expect(doc.blocks.length).toBeGreaterThan(3);
  });
  it("includes a playable audio element", () => {
    expect(doc.blocks.some((b) => b.type === "audio")).toBe(true);
  });
  it("links back into the app", () => {
    expect(doc.links.some((l) => l.internal)).toBe(true);
  });
  it("explains that it is a rendered page", () => {
    expect(doc.notice).toMatch(/offline demo/i);
  });
  it("includes catalog metadata", () => {
    const track = TRACKS.find((t) => t.title === result.title)!;
    expect(doc.blocks.some((b) => b.text === track.description)).toBe(true);
  });
  it("marks itself as not live", () => {
    expect(doc.fetchedLive).toBe(false);
  });
});

describe("browseUrl", () => {
  it("returns a document when the page cannot be fetched", async () => {
    const result = offlineResults("cloud sofa", 1)[0];
    const doc = await browseUrl("https://this-domain-definitely-does-not-exist.invalid/page", result);
    expect(doc.blocks.length).toBeGreaterThan(0);
    // falls back to the rendered demo page for that result
    expect(doc.notice).toMatch(/offline demo/i);
    expect(doc.fetchedLive).toBe(false);
  }, 20000);

  it("returns an error document with no fallback", async () => {
    const doc = await browseUrl("https://this-domain-definitely-does-not-exist.invalid/page");
    expect(doc.fetchedLive).toBe(false);
    expect(doc.notice).toMatch(/unavailable|Could not/i);
  }, 20000);
});
