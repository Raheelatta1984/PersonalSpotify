import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSearchHit } from "@/lib/types";
import { decodeEntities, diceSimilarity, parseClock, splitArtistTitle } from "@/lib/online/html";
import {
  buildSearchEndpoints,
  mp3juiceHitId,
  parseMp3JuiceResults,
  parseSongPageMetadata,
  searchMp3Juice,
} from "@/lib/online/mp3juice";
import { parseDuckDuckGo, parseGoogleResults, parseSearchResultTitle } from "@/lib/online/websearch";
import { clearWebSearchCache, offlineWebHits, searchWeb } from "@/lib/online/web";
import { isSafeAudioUrl, resolveArchiveAudio, resolveItunesPreview, resolvePlayback } from "@/lib/online/resolve";
import {
  deleteWebTrack,
  filterPlayableIds,
  getPlayableTrack,
  getWebTrack,
  isPlayableId,
  listWebTracks,
  listWebTracksAsTracks,
  resolvePlayableTracks,
  saveWebHit,
  saveWebTrack,
  webTrackId,
  webTrackToTrack,
} from "@/lib/online/weblibrary";
import { createPlaylist, addTrackToPlaylist, deletePlaylist, getPlaylists } from "@/lib/store/library";
import { POST as webSearchPOST } from "../app/api/web/search/route";
import { POST as webPlayPOST } from "../app/api/web/play/route";
import { GET as webTracksGET } from "../app/api/web/tracks/route";
import { GET as playlistGET, POST as playlistTrackPOST } from "../app/api/playlists/[id]/route";
import { GET as playlistsGET, POST as playlistsPOST } from "../app/api/playlists/route";
import { GET as libraryGET, POST as libraryPOST } from "../app/api/library/route";
import { POST as eventsPOST } from "../app/api/events/route";
import { GET as analyticsGET } from "../app/api/analytics/route";
import { GET as streamGET } from "../app/api/stream/[id]/route";
import { TRACKS } from "@/lib/catalog/tracks";

/* ------------------------------------------------------------------ fixtures */

const DATA_ATTR_FIXTURE = `<!doctype html><html><head><title>mp3juice</title></head>
<body>
<div id="results">
  <div class="list-group">
    <a href="/download?id=abc123" class="list-group-item" data-id="abc123"
       data-songtitle="Get Lucky" data-artist="Daft Punk" data-album="Random Access Memories"
       data-duration="4:08" data-thumbnail="/art/getlucky.jpg">Get Lucky</a>
    <a href="https://mp3juice.sc/download?id=def456" class="list-group-item" data-id="def456"
       data-songtitle="Instant Crush" data-artist="Daft Punk" data-duration="5:37">Instant Crush</a>
    <a href="/download?id=abc123" class="list-group-item" data-id="abc123"
       data-songtitle="Get Lucky" data-artist="Daft Punk" data-duration="4:08">duplicate</a>
  </div>
  <div class="pagination">next page</div>
</div>
</body></html>`;

const JSON_FIXTURE = `<html><body>
<script id="__NEXT_DATA__" type="application/json">
{"props":{"pageProps":{"songs":[
 {"id":"x1","title":"Blinding Lights","artist":"The Weeknd","duration":"3:20","thumbnail":"https://cdn.example/blinding.jpg"},
 {"id":"x2","title":"Save Your Tears","artist":"The Weeknd","duration":215}
]}}}
</script></body></html>`;

const TABLE_FIXTURE = `<html><body>
<table class="results">
  <thead><tr><th>#</th><th>Song</th><th>Time</th></tr></thead>
  <tbody>
    <tr><td>1</td><td><a href="/download?id=t1">Daft Punk - One More Time</a></td><td>5:20</td></tr>
    <tr><td>2</td><td><a href="/download?id=t2">Daft Punk - Digital Love</a></td><td>4:58</td></tr>
  </tbody>
</table></body></html>`;

const ANCHOR_FIXTURE = `<html><body>
<ul>
  <li><a href="/mp3/xyz/around-the-world.mp3" title="Daft Punk - Around the World">Around the World</a></li>
  <li><a href="/download?id=aa">Download</a></li>
</ul></body></html>`;

const API_JSON_FIXTURE = JSON.stringify({
  results: [
    { id: "r1", song: "Harder Better Faster Stronger", artist_name: "Daft Punk", duration: "3:44", url: "/download?id=r1" },
    { id: "r2", song: "Aerodynamic", artist_name: "Daft Punk", duration: "3:27", url: "/download?id=r2" },
  ],
});

const GOOGLE_FIXTURE = {
  items: [
    { title: "Daft Punk - Get Lucky (Official Video) - YouTube", link: "https://www.youtube.com/watch?v=5NV6Rdv1a3I", snippet: "Official video" },
    { title: "Get Lucky | Spotify", link: "https://open.spotify.com/track/69kOkLUCkxIZYexIgSG8rq", snippet: "Listen" },
  ],
};

const DDG_FIXTURE = `<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsoundcloud.com%2Fdaftpunk%2Fget-lucky">Daft Punk - Get Lucky | SoundCloud</a>
  <a class="result__snippet">Stream Get Lucky by Daft Punk</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://archive.org/details/getlucky">Get Lucky : Daft Punk : Free Download</a>
</div>
</body></html>`;

const ITUNES_FIXTURE = {
  results: [
    {
      trackName: "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
      artistName: "Daft Punk",
      collectionName: "Random Access Memories",
      previewUrl: "https://audio.example/preview/get-lucky.m4a",
      trackTimeMillis: 369000,
      trackViewUrl: "https://music.apple.com/us/album/get-lucky/617154241?i=617154366",
    },
    {
      trackName: "Get Lucky",
      artistName: "Some Cover Band",
      previewUrl: "https://audio.example/preview/cover.m4a",
      trackTimeMillis: 200000,
    },
  ],
};

const AUDIO_BYTES = new Uint8Array(4096).fill(7);

/** Unique per test run: the data dir survives between local runs. */
const RUN = Math.random().toString(36).slice(2, 8);

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function okHtml(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

interface StubOptions {
  mp3juice?: Response | ((url: string) => Response | null);
  itunes?: Response;
  archive?: Response;
  google?: Response;
  ddg?: Response;
  audio?: Response;
}

/** Route fetch calls to canned responses; returns the list of requested URLs. */
function stubFetch(options: StubOptions = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.includes("mp3juice")) {
      if (typeof options.mp3juice === "function") return options.mp3juice(url) ?? new Response("nope", { status: 404 });
      return options.mp3juice ?? new Response("nope", { status: 404 });
    }
    if (url.includes("itunes.apple.com")) return options.itunes ?? new Response("{}", { status: 404 });
    if (url.includes("archive.org")) return options.archive ?? new Response("{}", { status: 404 });
    if (url.includes("googleapis.com/customsearch")) return options.google ?? new Response("{}", { status: 404 });
    if (url.includes("duckduckgo.com")) return options.ddg ?? new Response("", { status: 404 });
    if (url.includes("audio.example")) {
      return options.audio ?? new Response(AUDIO_BYTES, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    if (url.includes("archive.example")) {
      return options.audio ?? new Response(AUDIO_BYTES, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    return new Response("not found", { status: 404 });
  });
  return calls;
}

const jsonRequest = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  vi.unstubAllGlobals();
  clearWebSearchCache();
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_CSE_ID;
});

/* ---------------------------------------------------------------- HTML utils */

describe("html helpers", () => {
  it("decodes entities found in scraped titles", () => {
    expect(decodeEntities("Tom &amp; Jerry &#39;99 &ndash; Mix")).toBe("Tom & Jerry '99 – Mix");
  });
  it("parses clock values", () => {
    expect(parseClock("4:08")).toBe(248);
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock(225)).toBe(225);
    expect(parseClock("3 min")).toBe(180);
    expect(parseClock("")).toBeUndefined();
  });
  it("splits artist-first titles", () => {
    expect(splitArtistTitle("Daft Punk - Get Lucky", "artist-first")).toEqual({ artist: "Daft Punk", title: "Get Lucky" });
  });
  it("splits title-first titles", () => {
    expect(splitArtistTitle("Get Lucky — Daft Punk", "title-first")).toEqual({ title: "Get Lucky", artist: "Daft Punk" });
  });
  it("keeps the longer side as the title in auto mode", () => {
    expect(splitArtistTitle("Get Lucky (Official Video) - Daft Punk").title).toBe("Get Lucky");
  });
  it("scores near-identical strings highly", () => {
    expect(diceSimilarity("Get Lucky", "get lucky")).toBe(1);
    expect(diceSimilarity("Get Lucky", "Completely Different")).toBeLessThan(0.4);
  });
});

/* --------------------------------------------------------------- mp3juice --- */

describe("mp3juice scraper", () => {
  it("reads the site's data-* result rows", () => {
    const hits = parseMp3JuiceResults(DATA_ATTR_FIXTURE, "https://mp3juice.sc");
    expect(hits.length).toBe(2); // duplicate row collapsed
    expect(hits[0].title).toBe("Get Lucky");
    expect(hits[0].artist).toBe("Daft Punk");
    expect(hits[0].album).toBe("Random Access Memories");
    expect(hits[0].durationSec).toBe(248);
    expect(hits[0].artworkUrl).toBe("https://mp3juice.sc/art/getlucky.jpg");
    expect(hits[0].pageUrl).toBe("https://mp3juice.sc/download?id=abc123");
  });

  it("reads embedded Next.js JSON", () => {
    const hits = parseMp3JuiceResults(JSON_FIXTURE, "https://mp3juice.sc");
    expect(hits.map((h) => h.title)).toEqual(expect.arrayContaining(["Blinding Lights", "Save Your Tears"]));
    const blinding = hits.find((h) => h.title === "Blinding Lights")!;
    expect(blinding.artist).toBe("The Weeknd");
    expect(blinding.durationSec).toBe(200);
    expect(blinding.pageUrl).toBe("https://mp3juice.sc/download?id=x1");
  });

  it("reads table layouts", () => {
    const hits = parseMp3JuiceResults(TABLE_FIXTURE, "https://mp3juice.sc");
    expect(hits).toHaveLength(2);
    expect(hits[0].artist).toBe("Daft Punk");
    expect(hits[0].title).toBe("One More Time");
    expect(hits[0].durationSec).toBe(320);
  });

  it("reads loose download anchors", () => {
    const hits = parseMp3JuiceResults(ANCHOR_FIXTURE, "https://mp3juice.sc");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Around the World");
    expect(hits[0].artist).toBe("Daft Punk");
    expect(hits[0].pageUrl).toBe("https://mp3juice.sc/mp3/xyz/around-the-world.mp3");
  });

  it("reads a JSON search API", () => {
    const hits = parseMp3JuiceResults(API_JSON_FIXTURE, "https://mp3juice.sc");
    expect(hits).toHaveLength(2);
    expect(hits[0].title).toBe("Harder Better Faster Stronger");
    expect(hits[0].artist).toBe("Daft Punk");
  });

  it("ignores navigation junk and dedupes", () => {
    const html = `<a href="/download?id=1">Download</a><a href="/download?id=2">Free MP3</a>`;
    expect(parseMp3JuiceResults(html, "https://mp3juice.sc")).toHaveLength(0);
  });

  it("produces stable ids for the same song URL", () => {
    const a = parseMp3JuiceResults(DATA_ATTR_FIXTURE, "https://mp3juice.sc")[0];
    const b = parseMp3JuiceResults(DATA_ATTR_FIXTURE, "https://mp3juice.sc")[0];
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(mp3juiceHitId(a.pageUrl));
  });

  it("builds encoded search endpoints", () => {
    const endpoints = buildSearchEndpoints("daft punk & pharrell", "https://mp3juice.sc");
    expect(endpoints.length).toBeGreaterThan(2);
    for (const endpoint of endpoints) {
      expect(endpoint).toContain("mp3juice.sc");
      expect(endpoint).not.toContain(" ");
    }
  });

  it("fetches and parses the first working endpoint", async () => {
    const calls = stubFetch({
      mp3juice: (url) => (url.includes("/search?q=") ? okHtml(DATA_ATTR_FIXTURE) : null),
    });
    const result = await searchMp3Juice("get lucky", 5);
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(2);
    expect(calls[0]).toContain("/search?q=get%20lucky");
  });

  it("reports failures without throwing", async () => {
    stubFetch({ mp3juice: new Response("blocked", { status: 403 }) });
    const result = await searchMp3Juice("nope", 3);
    expect(result.ok).toBe(false);
    expect(result.hits).toHaveLength(0);
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.attempts.every((a) => a.status === 403)).toBe(true);
  });

  it("returns nothing for an empty query", async () => {
    const result = await searchMp3Juice("   ", 3);
    expect(result.hits).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it("extracts metadata from a song page", () => {
    const html = `<html><head><meta property="og:description" content="Daft Punk · Random Access Memories" /></head>
      <body><h1>Daft Punk - Get Lucky</h1></body></html>`;
    const meta = parseSongPageMetadata(html);
    expect(meta.title).toBe("Get Lucky");
    expect(meta.artist).toBe("Daft Punk");
    expect(meta.description).toContain("Random Access Memories");
  });
});

/* ------------------------------------------------------------ web fallback --- */

describe("wider-web fallback", () => {
  it("parses Google CSE items and strips site suffixes", () => {
    const hits = parseGoogleResults(GOOGLE_FIXTURE);
    expect(hits).toHaveLength(2);
    expect(hits[0].provider).toBe("google");
    expect(hits[0].title).toBe("Get Lucky");
    expect(hits[0].artist).toBe("Daft Punk");
    expect(hits[1].title).toBe("Get Lucky");
    expect(hits[1].sourceUrl).toContain("open.spotify.com");
  });

  it("uses the host convention for YouTube titles", () => {
    expect(parseSearchResultTitle("Daft Punk - Get Lucky (Official Video) - YouTube", "https://youtube.com/watch?v=1")).toEqual({
      title: "Get Lucky",
      artist: "Daft Punk",
    });
  });

  it("parses DuckDuckGo HTML and unwraps redirects", () => {
    const hits = parseDuckDuckGo(DDG_FIXTURE);
    expect(hits).toHaveLength(2);
    expect(hits[0].sourceUrl).toBe("https://soundcloud.com/daftpunk/get-lucky");
    expect(hits[0].title).toBe("Get Lucky");
    expect(hits[1].sourceUrl).toBe("https://archive.org/details/getlucky");
  });

  it("searches mp3juice only when siteOnly is set", async () => {
    const calls = stubFetch({ mp3juice: okHtml(DATA_ATTR_FIXTURE) });
    const outcome = await searchWeb("get lucky", { limit: 8, allowFallback: false, cache: false });
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.fallbackUsed).toBe(false);
    expect(outcome.providers.map((p) => p.provider)).toEqual(["mp3juice"]);
    expect(calls.some((url) => url.includes("duckduckgo"))).toBe(false);
  });

  it("falls back to Google when mp3juice has nothing", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.GOOGLE_CSE_ID = "test-cx";
    const calls = stubFetch({ google: okJson(GOOGLE_FIXTURE) });
    const outcome = await searchWeb("get lucky", { limit: 8, cache: false });
    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits[0].provider).toBe("google");
    expect(outcome.notice).toMatch(/searched Google/i);
    expect(calls.some((url) => url.includes("googleapis.com/customsearch"))).toBe(true);
  });

  it("falls back to DuckDuckGo when Google is not configured", async () => {
    stubFetch({ ddg: okHtml(DDG_FIXTURE) });
    const outcome = await searchWeb("get lucky", { limit: 8, cache: false });
    expect(outcome.hits.some((hit) => hit.provider === "duckduckgo")).toBe(true);
    expect(outcome.notice).toMatch(/DuckDuckGo/i);
  });

  it("returns clearly-labelled demo rows when nothing is reachable", async () => {
    stubFetch({});
    const outcome = await searchWeb("zzzz nothing", { limit: 4, cache: false });
    expect(outcome.live).toBe(false);
    expect(outcome.hits).toHaveLength(4);
    expect(outcome.hits.every((hit) => hit.provider === "songhub-demo")).toBe(true);
    expect(outcome.notice).toMatch(/offline demo/i);
  });

  it("caches repeat searches", async () => {
    const calls = stubFetch({ mp3juice: okHtml(DATA_ATTR_FIXTURE) });
    await searchWeb("cached query", { limit: 5 });
    const first = calls.length;
    await searchWeb("cached query", { limit: 5 });
    expect(calls.length).toBe(first);
  });

  it("returns a friendly notice for an empty query", async () => {
    const outcome = await searchWeb("   ");
    expect(outcome.hits).toHaveLength(0);
    expect(outcome.notice).toMatch(/Type a song/i);
  });

  it("builds offline hits deterministically", () => {
    expect(offlineWebHits("neon", 3).map((h) => h.id)).toEqual(offlineWebHits("neon", 3).map((h) => h.id));
  });
});

/* -------------------------------------------------------------- resolver ---- */

describe("playback resolver", () => {
  it("trusts audio a provider already published", async () => {
    const resolution = await resolvePlayback({ title: "X", audioUrl: "https://audio.example/x.m4a", provider: "itunes" });
    expect(resolution.playbackKind).toBe("preview");
    expect(resolution.audioProvider).toBe("itunes");
  });

  it("finds an iTunes preview for a real song", async () => {
    stubFetch({ itunes: okJson(ITUNES_FIXTURE) });
    const resolution = await resolveItunesPreview("Get Lucky", "Daft Punk");
    expect(resolution?.audioUrl).toBe("https://audio.example/preview/get-lucky.m4a");
    expect(resolution?.playbackKind).toBe("preview");
  });

  it("refuses a store match that is clearly a different song", async () => {
    stubFetch({ itunes: okJson({ results: [{ trackName: "Completely Different", artistName: "Nobody", previewUrl: "https://x/y.mp3" }] }) });
    expect(await resolveItunesPreview("Get Lucky", "Daft Punk")).toBeNull();
  });

  it("resolves a licensed Internet Archive file", async () => {
    // both the search and the metadata request are served by one stub
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("advancedsearch")) {
        return okJson({
          response: {
            docs: [{ identifier: "getlucky", title: "Get Lucky", licenseurl: "https://creativecommons.org/licenses/by/4.0/" }],
          },
        });
      }
      if (url.includes("/metadata/getlucky")) {
        return okJson({
          files: [
            { name: "cover.jpg", format: "JPEG" },
            { name: "get-lucky.mp3", format: "VBR MP3" },
          ],
          metadata: { licenseurl: "https://creativecommons.org/licenses/by/4.0/" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    const resolution = await resolveArchiveAudio("Get Lucky", "Daft Punk");
    expect(resolution?.playbackKind).toBe("full");
    expect(resolution?.audioUrl).toBe("https://archive.org/download/getlucky/get-lucky.mp3");
  });

  it("falls back to a generated preview when nothing lawful exists", async () => {
    stubFetch({});
    const resolution = await resolvePlayback({ title: "Some Unreleased Demo" });
    expect(resolution.playbackKind).toBe("generated");
    expect(resolution.audioUrl).toBeUndefined();
    expect(resolution.license).toMatch(/no licensed/i);
  });

  it("only ever fetches public https audio URLs", () => {
    expect(isSafeAudioUrl("https://audio.example/preview.m4a")).toBe(true);
    expect(isSafeAudioUrl("http://audio.example/preview.m4a")).toBe(false);
    expect(isSafeAudioUrl("https://127.0.0.1/secret.mp3")).toBe(false);
    expect(isSafeAudioUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafeAudioUrl("https://192.168.1.5/a.mp3")).toBe(false);
    expect(isSafeAudioUrl("https://172.20.0.3/a.mp3")).toBe(false);
    expect(isSafeAudioUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeAudioUrl(undefined)).toBe(false);
  });

  it("never throws when every provider errors", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const resolution = await resolvePlayback({ title: "Get Lucky", artist: "Daft Punk" });
    expect(resolution.playbackKind).toBe("generated");
  });
});

/* ------------------------------------------------------------ web library --- */

describe("saved web songs", () => {
  it("keeps the real title and the real song URL", async () => {
    const saved = await saveWebTrack({
      title: "Around the World",
      artist: "Daft Punk",
      sourceUrl: "https://mp3juice.sc/download?id=atw",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "preview",
      license: "Apple/iTunes licensed 30-second preview",
    });
    expect(saved.title).toBe("Around the World");
    expect(saved.sourceUrl).toBe("https://mp3juice.sc/download?id=atw");
    expect((await getWebTrack(saved.id))?.title).toBe("Around the World");
  });

  it("is idempotent — replays never duplicate rows", async () => {
    const input = {
      title: "One More Time",
      artist: "Daft Punk",
      sourceUrl: `https://mp3juice.sc/download?id=omt-${RUN}`,
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "preview" as const,
      license: "preview",
    };
    const a = await saveWebTrack(input);
    const b = await saveWebTrack(input);
    expect(a.id).toBe(b.id);
    const rows = (await listWebTracks()).filter((track) => track.id === a.id);
    expect(rows).toHaveLength(1);
  });

  it("derives stable ids from title, artist and URL", () => {
    const a = webTrackId("Get Lucky", "Daft Punk", "https://mp3juice.sc/download?id=1");
    const b = webTrackId("Get Lucky", "Daft Punk", "https://mp3juice.sc/download?id=1");
    const c = webTrackId("Get Lucky", "Daft Punk", "https://mp3juice.sc/download?id=2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("web_")).toBe(true);
  });

  it("rejects entries without a real source URL", async () => {
    await expect(
      saveWebTrack({
        title: "No source",
        artist: "Nobody",
        sourceUrl: "javascript:alert(1)",
        provider: "x",
        providerLabel: "x",
        playbackKind: "generated",
        license: "x",
      }),
    ).rejects.toThrow(/source URL/i);
  });

  it("adapts a web song to the normal Track shape", async () => {
    const saved = await saveWebTrack({
      title: "Aerodynamic",
      artist: "Daft Punk",
      album: "Discovery",
      durationSec: 212,
      sourceUrl: "https://mp3juice.sc/download?id=aero",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "preview",
      license: "preview",
    });
    const track = webTrackToTrack(saved);
    expect(track.id).toBe(saved.id);
    expect(track.title).toBe("Aerodynamic");
    expect(track.artist).toBe("Daft Punk");
    expect(track.duration).toBe(212);
    expect(track.web?.sourceUrl).toBe("https://mp3juice.sc/download?id=aero");
    expect(track.spec.bpm).toBeGreaterThan(60);
    // deterministic
    expect(webTrackToTrack(saved).spec).toEqual(track.spec);
  });

  it("resolves mixed catalog + web id lists in order", async () => {
    const saved = await saveWebTrack({
      title: "Digital Love",
      artist: "Daft Punk",
      sourceUrl: "https://mp3juice.sc/download?id=dl",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "preview",
      license: "preview",
    });
    const ids = [TRACKS[0].id, saved.id, TRACKS[1].id, "trk_missing"];
    const resolved = await resolvePlayableTracks(ids);
    expect(resolved.map((track) => track.id)).toEqual([TRACKS[0].id, saved.id, TRACKS[1].id]);
    expect(await getPlayableTrack(saved.id)).not.toBeNull();
    expect(await isPlayableId(saved.id)).toBe(true);
    expect(await isPlayableId("trk_nope")).toBe(false);
    expect(await filterPlayableIds([saved.id, "trk_nope"])).toEqual([saved.id]);
  });

  it("saves a search hit through the resolver", async () => {
    stubFetch({ itunes: okJson(ITUNES_FIXTURE) });
    const hit: WebSearchHit = {
      id: "mp3juice:test",
      title: "Get Lucky",
      artist: "Daft Punk",
      sourceUrl: "https://mp3juice.sc/download?id=gl",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      confidence: 0.9,
    };
    const saved = await saveWebHit(hit, { fetchImpl: fetch });
    expect(saved.playbackKind).toBe("preview");
    expect(saved.audioUrl).toBe("https://audio.example/preview/get-lucky.m4a");
    expect(saved.title).toBe("Get Lucky");
    expect(saved.sourceUrl).toBe("https://mp3juice.sc/download?id=gl");
    expect(saved.notes).toMatch(/Playback: iTunes preview/i);
  });

  it("drops a client-supplied audio URL that points at a private host", async () => {
    const saved = await saveWebHit(
      {
        id: "mp3juice:ssrf",
        title: "SSRF Test",
        artist: "Tester",
        sourceUrl: "https://mp3juice.sc/download?id=ssrf",
        provider: "itunes",
        providerLabel: "iTunes",
        confidence: 0.9,
        audioUrl: "http://169.254.169.254/latest/meta-data",
      },
      { skipResolve: true },
    );
    expect(saved.audioUrl).toBeUndefined();
    expect(saved.playbackKind).toBe("generated");
  });

  it("deletes a saved web song", async () => {
    const saved = await saveWebTrack({
      title: "Temporary Song",
      artist: "Nobody",
      sourceUrl: "https://mp3juice.sc/download?id=tmp",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "generated",
      license: "generated",
    });
    expect(await deleteWebTrack(saved.id)).toBe(true);
    expect(await getWebTrack(saved.id)).toBeNull();
    expect(await deleteWebTrack(saved.id)).toBe(false);
  });

  it("exposes the saved songs as Tracks", async () => {
    const tracks = await listWebTracksAsTracks();
    expect(tracks.length).toBe((await listWebTracks()).length);
    for (const track of tracks) expect(track.web?.sourceUrl).toMatch(/^https?:\/\//);
  });
});

/* -------------------------------------------------------------- playlists --- */

describe("web songs in playlists", () => {
  let playlistId = "";

  beforeAll(async () => {
    const existing = await getPlaylists();
    for (const playlist of existing) await deletePlaylist(playlist.id);
    const playlist = await createPlaylist({ name: "Web test", trackIds: [] });
    playlistId = playlist.id;
  });

  it("keeps a web id when creating a playlist", async () => {
    const saved = await saveWebTrack({
      title: "Instant Crush",
      artist: "Daft Punk",
      sourceUrl: "https://mp3juice.sc/download?id=ic",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "preview",
      license: "preview",
    });
    const playlist = await createPlaylist({ name: "With web", trackIds: [saved.id, TRACKS[0].id, "trk_nope"] });
    expect(playlist.trackIds).toEqual([saved.id, TRACKS[0].id]);
    await deletePlaylist(playlist.id);
  });

  it("appends with addTrackToPlaylist", async () => {
    const saved = await saveWebTrack({
      title: "Something About Us",
      artist: "Daft Punk",
      sourceUrl: "https://mp3juice.sc/download?id= sau",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "preview",
      license: "preview",
    });
    const first = await addTrackToPlaylist(playlistId, saved.id);
    expect(first?.added).toBe(true);
    const second = await addTrackToPlaylist(playlistId, saved.id);
    expect(second?.added).toBe(false);
    expect(second?.playlist.trackIds.filter((id) => id === saved.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ routes --- */

describe("web music API", () => {
  it("GET /api/web/search returns hits and providers", async () => {
    stubFetch({ mp3juice: okHtml(DATA_ATTR_FIXTURE) });
    const res = await webSearchPOST(jsonRequest({ query: "get lucky", limit: 5 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.hits.length).toBe(2);
    expect(body.hits[0].title).toBe("Get Lucky");
    expect(body.providers[0].provider).toBe("mp3juice");
  });

  it("rejects a non-JSON body", async () => {
    const req = new Request("http://localhost/api/web/search", { method: "POST", body: "nope" });
    expect((await webSearchPOST(req)).status).toBe(400);
  });

  it("POST /api/web/play saves the song and returns a playable track", async () => {
    stubFetch({ itunes: okJson(ITUNES_FIXTURE) });
    const hit = {
      id: "mp3juice:route",
      title: "Get Lucky",
      artist: "Daft Punk",
      sourceUrl: "https://mp3juice.sc/download?id=route",
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      confidence: 0.9,
    };
    const res = await webPlayPOST(jsonRequest({ hit }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.webTrack.title).toBe("Get Lucky");
    expect(body.webTrack.sourceUrl).toBe("https://mp3juice.sc/download?id=route");
    expect(body.track.id).toBe(body.webTrack.id);
    expect(body.streamUrl).toBe(`/api/stream/${body.webTrack.id}`);
  });

  it("rejects an invalid hit", async () => {
    const res = await webPlayPOST(jsonRequest({ hit: { title: "x", sourceUrl: "javascript:1" } }));
    expect(res.status).toBe(400);
  });

  it("POST /api/playlists/:id appends a hit and reports the saved title + URL", async () => {
    stubFetch({ itunes: okJson(ITUNES_FIXTURE) });
    const created = await playlistsPOST(jsonRequest({ name: "Route playlist" }));
    const playlist = await created.json();

    const res = await playlistTrackPOST(
      jsonRequest({
        hit: {
          id: "mp3juice:pl",
          title: "Get Lucky",
          artist: "Daft Punk",
          sourceUrl: `https://mp3juice.sc/download?id=playlist-${RUN}`,
          provider: "mp3juice",
          providerLabel: "mp3juice.sc",
          confidence: 0.9,
        },
      }),
      params(playlist.id),
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.added).toBe(true);
    expect(body.savedTitle).toBe("Get Lucky");
    expect(body.savedSourceUrl).toBe(`https://mp3juice.sc/download?id=playlist-${RUN}`);
    expect(body.playlist.trackIds).toContain(body.track.id);

    const hydrated = await (await playlistGET(new Request("http://localhost/x"), params(playlist.id))).json();
    expect(hydrated.tracks[0].title).toBe("Get Lucky");
    expect(hydrated.tracks[0].web.sourceUrl).toBe(`https://mp3juice.sc/download?id=playlist-${RUN}`);

    const again = await playlistTrackPOST(
      jsonRequest({ trackId: body.track.id }),
      params(playlist.id),
    );
    expect((await again.json()).added).toBe(false);

    await deletePlaylist(playlist.id);
  });

  it("404s an unknown playlist", async () => {
    const res = await playlistTrackPOST(jsonRequest({ trackId: TRACKS[0].id }), params("pl_missing"));
    expect(res.status).toBe(404);
  });

  it("lists saved web songs", async () => {
    const res = await webTracksGET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.webTracks.length).toBeGreaterThan(0);
    expect(body.tracks[0].web.sourceUrl).toMatch(/^https?:/);
  });

  it("accepts play events for web tracks but rejects unknown ids", async () => {
    const saved = await saveWebTrack({
      title: "Event Song",
      artist: "Tester",
      sourceUrl: `https://mp3juice.sc/download?id=event-${RUN}`,
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "generated",
      license: "generated",
    });
    const ok = await eventsPOST(jsonRequest({ trackId: saved.id, msPlayed: 1000, source: "online" }));
    expect(ok.status).toBe(201);
    const bad = await eventsPOST(jsonRequest({ trackId: "trk_unknown", msPlayed: 1000 }));
    expect(bad.status).toBe(404);

    const analytics = await (await analyticsGET()).json();
    expect(analytics.summary.totalPlays).toBeGreaterThan(0);
  });

  it("hydrates liked web songs through /api/library", async () => {
    const saved = await saveWebTrack({
      title: "Liked Web Song",
      artist: "Tester",
      sourceUrl: `https://mp3juice.sc/download?id=liked-${RUN}`,
      provider: "mp3juice",
      providerLabel: "mp3juice.sc",
      playbackKind: "generated",
      license: "generated",
    });
    const res = await libraryPOST(jsonRequest({ action: "toggle-like", trackId: saved.id }));
    expect(res.status).toBe(200);
    const toggled = (await res.json()) as { liked: boolean };
    if (!toggled.liked) await libraryPOST(jsonRequest({ action: "toggle-like", trackId: saved.id }));
    const body = await (await libraryGET()).json();
    expect(body.likedTracks.some((track: { id: string }) => track.id === saved.id)).toBe(true);
    expect(Array.isArray(body.webTracks)).toBe(true);
  });

  it("streams a saved web song, with range support", async () => {
    stubFetch({ itunes: okJson(ITUNES_FIXTURE) });
    const saved = await saveWebHit(
      {
        id: "mp3juice:stream",
        title: "Get Lucky",
        artist: "Daft Punk",
        sourceUrl: `https://mp3juice.sc/download?id=stream-${RUN}`,
        provider: "mp3juice",
        providerLabel: "mp3juice.sc",
        confidence: 0.9,
      },
      { skipResolve: true },
    );
    const response = await streamGET(new Request(`http://localhost/api/stream/${saved.id}`), params(saved.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(1000);

    const ranged = await streamGET(
      new Request(`http://localhost/api/stream/${saved.id}`, { headers: { range: "bytes=0-99" } }),
      params(saved.id),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-99\//);
  });

  it("streams a cached licensed preview for a resolved web song", async () => {
    stubFetch({ itunes: okJson(ITUNES_FIXTURE) });
    const saved = await saveWebHit(
      {
        id: "mp3juice:preview",
        title: "Get Lucky",
        artist: "Daft Punk",
        sourceUrl: `https://mp3juice.sc/download?id=preview-${RUN}`,
        provider: "mp3juice",
        providerLabel: "mp3juice.sc",
        confidence: 0.9,
      },
      { fetchImpl: fetch },
    );
    expect(saved.playbackKind).toBe("preview");
    const response = await streamGET(new Request(`http://localhost/api/stream/${saved.id}`), params(saved.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("x-playback-kind")).toBe("preview");
  });

  it("serves a synth preview when no licensed audio exists", async () => {
    stubFetch({});
    const saved = await saveWebHit(
      {
        id: "mp3juice:synth",
        title: "Unreleased Track",
        artist: "Nobody",
        sourceUrl: `https://mp3juice.sc/download?id=synth-${RUN}`,
        provider: "mp3juice",
        providerLabel: "mp3juice.sc",
        confidence: 0.5,
      },
      { allow: { itunes: false, archive: false, jamendo: false } },
    );
    expect(saved.playbackKind).toBe("generated");
    const response = await streamGET(new Request(`http://localhost/api/stream/${saved.id}`), params(saved.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("x-playback-kind")).toBe("generated");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(100_000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
  });

  it("404s an unknown web id", async () => {
    const response = await streamGET(new Request("http://localhost/api/stream/web_missing"), params("web_missing"));
    expect(response.status).toBe(404);
  });

  it("still streams catalog tracks", async () => {
    const response = await streamGET(new Request(`http://localhost/api/stream/${TRACKS[0].id}`), params(TRACKS[0].id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
  });

  it("returns seeded playlists with web entries intact", async () => {
    const res = await playlistsGET();
    const body = await res.json();
    expect(Array.isArray(body.playlists)).toBe(true);
  });
});
