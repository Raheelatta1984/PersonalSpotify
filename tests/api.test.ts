import { beforeAll, describe, expect, it } from "vitest";
import { GET as healthGET } from "../app/api/health/route";
import { GET as catalogGET } from "../app/api/catalog/route";
import { GET as trackGET } from "../app/api/tracks/[id]/route";
import { GET as searchGET, POST as searchPOST } from "../app/api/search/route";
import { GET as streamGET, HEAD as streamHEAD } from "../app/api/stream/[id]/route";
import { GET as identifyGET, POST as identifyPOST } from "../app/api/identify/route";
import { GET as identifyStatusGET } from "../app/api/identify/status/route";
import { GET as onlineSearchGET, POST as onlineSearchPOST } from "../app/api/online/search/route";
import { POST as browsePOST } from "../app/api/online/browse/route";
import { POST as downloadPOST } from "../app/api/online/download/route";
import { GET as tempListGET } from "../app/api/temp/route";
import { DELETE as tempDelete, GET as tempGET } from "../app/api/temp/[token]/route";
import { GET as libraryGET, POST as libraryPOST } from "../app/api/library/route";
import { GET as playlistsGET, POST as playlistsPOST } from "../app/api/playlists/route";
import { DELETE as playlistDELETE, PATCH as playlistPATCH } from "../app/api/playlists/[id]/route";
import { GET as eventsGET, POST as eventsPOST } from "../app/api/events/route";
import { GET as analyticsGET } from "../app/api/analytics/route";
import { GET as recommendationsGET } from "../app/api/recommendations/route";
import { GET as qualitiesGET } from "../app/api/qualities/route";
import { GET as downloadFileGET } from "../app/api/download/[id]/route";
import { POST as aiPlaylistPOST } from "../app/api/ai/playlist/route";
import { TRACKS, BOLLYWOOD_TRACKS } from "@/lib/catalog/tracks";
import { encodeWav } from "@/lib/audio/wav";
import { renderRange } from "@/lib/audio/synth";
import { offlineResults } from "@/lib/online/sources";

/** Uint8Array -> ArrayBuffer with an exactly sized backing store (valid BodyInit). */
const asBody = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

const json = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

describe("GET /api/health", () => {
  it("reports the app identity", async () => {
    const res = await healthGET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.app).toBe("SongHub");
  });
  it("reports catalog counts", async () => {
    const body = await (await healthGET()).json();
    expect(body.catalog.tracks).toBe(TRACKS.length);
    expect(body.catalog.artists).toBeGreaterThan(5);
  });
  it("reports the fingerprint index", async () => {
    const body = await (await healthGET()).json();
    expect(["idle", "building", "ready"]).toContain(body.fingerprintIndex.status);
  });
  it("advertises features", async () => {
    const body = await (await healthGET()).json();
    expect(body.features.aiSearch).toBe(true);
    expect(body.features.listenAndIdentify).toBe(true);
    expect(body.features.tempDownloads).toBe(true);
  });
});

describe("GET /api/catalog", () => {
  it("returns every track", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog"))).json();
    expect(body.tracks).toHaveLength(TRACKS.length);
    expect(body.artists.length).toBeGreaterThan(5);
  });
  it("includes seeded playlists", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog"))).json();
    expect(body.playlists.length).toBeGreaterThan(0);
  });
  it("can skip playlists", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog?playlists=false"))).json();
    expect(body.playlists).toHaveLength(0);
  });
  it("reports stats", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog"))).json();
    expect(body.stats.tracks).toBe(TRACKS.length);
    expect(body.stats.totalMinutes).toBeGreaterThan(20);
  });
  it("includes a taste profile", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog"))).json();
    expect(body.taste).toBeDefined();
    expect(Array.isArray(body.taste.genres)).toBe(true);
  });
});

describe("GET /api/tracks/[id]", () => {
  it("returns a track with similar tracks", async () => {
    const res = await trackGET(new Request("http://localhost"), params(TRACKS[0].id));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.track.id).toBe(TRACKS[0].id);
    expect(body.similar.length).toBeGreaterThan(0);
    expect(body.streamUrl).toBe(`/api/stream/${TRACKS[0].id}`);
  });
  it("404s for an unknown id", async () => {
    const res = await trackGET(new Request("http://localhost"), params("ghost"));
    expect(res.status).toBe(404);
  });
});

describe("/api/search", () => {
  it("accepts a JSON query", async () => {
    const res = await searchPOST(json({ query: "calm lo-fi", limit: 5 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.hits.length).toBe(5);
  });
  it("works over GET with a query string", async () => {
    const res = await searchGET(new Request("http://localhost/api/search?q=jazz&limit=3"));
    const body = await res.json();
    expect(body.hits.length).toBe(3);
  });
  it("clamps the limit", async () => {
    const body = await (await searchPOST(json({ query: "music", limit: 9999 }))).json();
    expect(body.hits.length).toBeLessThanOrEqual(50);
  });
  it("defaults the limit", async () => {
    const body = await (await searchPOST(json({ query: "music" }))).json();
    expect(body.hits.length).toBe(12);
  });
  it("rejects malformed JSON", async () => {
    const bad = new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await searchPOST(bad)).status).toBe(400);
  });
  it("includes an answer and reasoning", async () => {
    const body = await (await searchPOST(json({ query: "rainy drive" }))).json();
    expect(body.answer.length).toBeGreaterThan(10);
    expect(Array.isArray(body.understanding.reasoning)).toBe(true);
  });
  it("handles an empty query", async () => {
    const body = await (await searchPOST(json({ query: "" }))).json();
    expect(body.hits.length).toBeGreaterThan(0);
  });
});

describe("/api/stream/[id]", () => {
  it("serves a full WAV", async () => {
    const res = await streamGET(new Request("http://localhost/api/stream/x"), params(TRACKS[0].id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(1000);
  });
  it("serves partial content for a Range request", async () => {
    const res = await streamGET(
      new Request("http://localhost/api/stream/x", { headers: { range: "bytes=0-1023" } }),
      params(TRACKS[0].id),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-1023\/\d+$/);
    expect(Number(res.headers.get("content-length"))).toBe(1024);
  });
  it("rejects an unsatisfiable range", async () => {
    const res = await streamGET(
      new Request("http://localhost/api/stream/x", { headers: { range: "bytes=999999999999-" } }),
      params(TRACKS[0].id),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toMatch(/^bytes \*\/\d+$/);
  });
  it("404s for an unknown track", async () => {
    const res = await streamGET(new Request("http://localhost"), params("ghost"));
    expect(res.status).toBe(404);
  });
  it("answers HEAD without a body", async () => {
    const res = await streamHEAD(new Request("http://localhost", { method: "HEAD" }), params(TRACKS[0].id));
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(1000);
  });
  it("404s HEAD for an unknown track", async () => {
    const res = await streamHEAD(new Request("http://localhost", { method: "HEAD" }), params("ghost"));
    expect(res.status).toBe(404);
  });
});

describe("/api/identify", () => {
  beforeAll(async () => {
    await (await identifyStatusGET()).json();
  }, 180000);

  it("documents its usage over GET", async () => {
    const body = await (await identifyGET()).json();
    expect(body.usage).toContain("PCM");
  });

  it("reports index status", async () => {
    const res = await identifyStatusGET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(["building", "ready"]).toContain(body.status);
  });

  it("identifies a WAV upload", async () => {
    const track = TRACKS[3];
    const samples = renderRange(track.spec, 200000, 6 * 8000, 8000);
    const body = await (
      await identifyPOST(
        new Request("http://localhost/api/identify", {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: asBody(encodeWav(samples, 8000)),
        }),
      )
    ).json();
    expect(body.best?.track.id).toBe(track.id);
    expect(body.ok).toBe(true);
  }, 60000);

  it("identifies raw PCM with a sample-rate header", async () => {
    const track = TRACKS[6];
    const samples = renderRange(track.spec, 300000, 6 * 8000, 8000);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
    const body = await (
      await identifyPOST(
        new Request("http://localhost/api/identify", {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-sample-rate": "8000" },
          body: pcm.buffer,
        }),
      )
    ).json();
    expect(body.candidates[0]?.track.id).toBe(track.id);
  }, 60000);

  it("rejects an empty body", async () => {
    const res = await identifyPOST(
      new Request("http://localhost/api/identify", { method: "POST", body: new Uint8Array(0) }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects multipart without an audio field", async () => {
    const form = new FormData();
    form.append("other", "value");
    const res = await identifyPOST(new Request("http://localhost/api/identify", { method: "POST", body: form }));
    expect(res.status).toBe(400);
  });

  it("accepts multipart with an audio file", async () => {
    const track = TRACKS[9];
    const samples = renderRange(track.spec, 100000, 6 * 8000, 8000);
    const form = new FormData();
    form.append("audio", new Blob([asBody(encodeWav(samples, 8000))], { type: "audio/wav" }), "clip.wav");
    const body = await (
      await identifyPOST(new Request("http://localhost/api/identify", { method: "POST", body: form }))
    ).json();
    expect(body.candidates[0]?.track.id).toBe(track.id);
  }, 60000);

  it("returns ok:false for silence", async () => {
    const body = await (
      await identifyPOST(
        new Request("http://localhost/api/identify", {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: asBody(encodeWav(new Float32Array(8000 * 4), 8000)),
        }),
      )
    ).json();
    expect(body.ok).toBe(false);
  }, 30000);
});

describe("/api/online", () => {
  it("searches online via POST", async () => {
    const res = await onlineSearchPOST(json({ query: "neon overpass", limit: 3 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(3);
  }, 30000);

  it("searches online via GET", async () => {
    const body = await (await onlineSearchGET(new Request("http://localhost/api/online/search?q=rain&limit=2"))).json();
    expect(body.results.length).toBeLessThanOrEqual(2);
  }, 30000);

  it("rejects malformed JSON for online search", async () => {
    const res = await onlineSearchPOST(
      new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" }),
    );
    expect(res.status).toBe(400);
  });

  it("renders a demo result page in the in-app browser", async () => {
    const first = offlineResults("road", 1)[0];
    const body = await (await browsePOST(json({ resultId: first.id, query: "road" }))).json();
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.url.length).toBeGreaterThan(0);
    expect(body.fetchedLive).toBe(false);
  }, 30000);

  it("renders whichever result the search returned (live or offline)", async () => {
    const search = await (await onlineSearchPOST(json({ query: "neon overpass", limit: 2 }))).json();
    expect(search.results.length).toBeGreaterThan(0);
    const body = await (await browsePOST(json({ resultId: search.results[0].id, query: "neon overpass" }))).json();
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(body.title.length).toBeGreaterThan(0);
  }, 30000);

  it("rejects browsing a non-http URL", async () => {
    const res = await browsePOST(json({ url: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("404s for an unknown result", async () => {
    const res = await browsePOST(json({ resultId: "local-web:nope", query: "nope" }));
    expect(res.status).toBe(404);
  });

  it("requires an identifier", async () => {
    const res = await browsePOST(json({}));
    expect(res.status).toBe(400);
  });

  it("rejects malformed browse JSON", async () => {
    const res = await browsePOST(
      new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
    );
    expect(res.status).toBe(400);
  });

  it("requires a resultId for downloads", async () => {
    const res = await downloadPOST(json({}));
    expect(res.status).toBe(400);
  });

  it("404s downloading an unknown result", async () => {
    const res = await downloadPOST(json({ resultId: "local-web:missing", query: "missing" }));
    expect(res.status).toBe(404);
  }, 30000);
});

describe("temp download endpoints", () => {
  let token = "";
  let streamUrl = "";

  beforeAll(async () => {
    const first = offlineResults("cloud", 1)[0];
    const res = await downloadPOST(json({ resultId: first.id, query: "cloud", ttlSeconds: 300 }));
    const body = await res.json();
    token = body.token;
    streamUrl = body.streamUrl;
  }, 60000);

  it("creates a download with 201", async () => {
    expect(token).toBeTruthy();
    expect(streamUrl).toBe(`/api/temp/${token}`);
  });

  it("lists active downloads", async () => {
    const body = await (await tempListGET()).json();
    expect(body.downloads.some((d: { token: string }) => d.token === token)).toBe(true);
  });

  it("streams the cached audio", async () => {
    const res = await tempGET(new Request("http://localhost/api/temp/x"), tokenParams(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(1000);
  });

  it("supports range requests on cached audio", async () => {
    const res = await tempGET(
      new Request("http://localhost/api/temp/x", { headers: { range: "bytes=0-999" } }),
      tokenParams(token),
    );
    expect(res.status).toBe(206);
    expect(Number(res.headers.get("content-length"))).toBe(1000);
  });

  it("404s for an unknown token", async () => {
    expect((await tempGET(new Request("http://localhost"), tokenParams("nope"))).status).toBe(404);
  });

  it("deletes the download", async () => {
    const res = await tempDelete(new Request("http://localhost", { method: "DELETE" }), tokenParams(token));
    expect((await res.json()).ok).toBe(true);
  });

  it("404s when deleting twice", async () => {
    const res = await tempDelete(new Request("http://localhost", { method: "DELETE" }), tokenParams(token));
    expect(res.status).toBe(404);
  });
});

describe("/api/library", () => {
  it("returns liked and recent tracks", async () => {
    const body = await (await libraryGET()).json();
    expect(Array.isArray(body.likedTracks)).toBe(true);
    expect(Array.isArray(body.recentTracks)).toBe(true);
    expect(Array.isArray(body.playlists)).toBe(true);
  });

  it("toggles a like", async () => {
    const first = await (await libraryPOST(json({ action: "toggle-like", trackId: TRACKS[0].id }))).json();
    expect(typeof first.liked).toBe("boolean");
    const second = await (await libraryPOST(json({ action: "toggle-like", trackId: TRACKS[0].id }))).json();
    expect(second.liked).toBe(!first.liked);
  });

  it("rejects an unknown action", async () => {
    expect((await libraryPOST(json({ action: "nope" }))).status).toBe(400);
  });

  it("404s for an unknown track", async () => {
    expect((await libraryPOST(json({ action: "toggle-like", trackId: "ghost" }))).status).toBe(404);
  });

  it("rejects malformed JSON", async () => {
    const res = await libraryPOST(
      new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: "<" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("/api/playlists", () => {
  let id = "";

  it("lists playlists", async () => {
    const body = await (await playlistsGET()).json();
    expect(body.playlists.length).toBeGreaterThan(0);
  });

  it("creates a playlist", async () => {
    const res = await playlistsPOST(json({ name: "API Mix", trackIds: [TRACKS[0].id], description: "made in tests" }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.name).toBe("API Mix");
    id = body.id;
  });

  it("rejects a playlist without a name", async () => {
    expect((await playlistsPOST(json({ trackIds: [] }))).status).toBe(400);
  });

  it("filters unknown tracks on create", async () => {
    const body = await (await playlistsPOST(json({ name: "Filtered", trackIds: ["ghost", TRACKS[1].id] }))).json();
    expect(body.trackIds).toEqual([TRACKS[1].id]);
  });

  it("renames a playlist", async () => {
    const body = await (await playlistPATCH(json({ name: "Renamed" }), params(id))).json();
    expect(body.name).toBe("Renamed");
  });

  it("404s patching a missing playlist", async () => {
    expect((await playlistPATCH(json({ name: "x" }), params("pl_missing"))).status).toBe(404);
  });

  it("deletes a playlist", async () => {
    expect((await playlistDELETE(new Request("http://localhost", { method: "DELETE" }), params(id))).status).toBe(200);
  });

  it("404s deleting twice", async () => {
    expect((await playlistDELETE(new Request("http://localhost", { method: "DELETE" }), params(id))).status).toBe(404);
  });
});

describe("/api/events", () => {
  it("records a play", async () => {
    const res = await eventsPOST(json({ trackId: TRACKS[2].id, msPlayed: 4200, source: "search" }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.trackId).toBe(TRACKS[2].id);
  });

  it("defaults an unknown source to queue", async () => {
    const body = await (await eventsPOST(json({ trackId: TRACKS[2].id, msPlayed: 100, source: "bogus" }))).json();
    expect(body.source).toBe("queue");
  });

  it("rejects a missing trackId", async () => {
    expect((await eventsPOST(json({ msPlayed: 100 }))).status).toBe(400);
  });

  it("404s an unknown track", async () => {
    expect((await eventsPOST(json({ trackId: "ghost", msPlayed: 1 }))).status).toBe(404);
  });

  it("clamps absurd listen times", async () => {
    const body = await (await eventsPOST(json({ trackId: TRACKS[2].id, msPlayed: 1e12 }))).json();
    expect(body.msPlayed).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("lists events", async () => {
    const body = await (await eventsGET()).json();
    expect(body.events.length).toBeGreaterThan(0);
  });
});

describe("/api/analytics", () => {
  it("summarises listening", async () => {
    const body = await (await analyticsGET()).json();
    expect(body.summary.totalPlays).toBeGreaterThan(0);
    expect(body.summary.byHour).toHaveLength(24);
    expect(body.summary.byDay).toHaveLength(7);
  });
  it("includes recent events", async () => {
    const body = await (await analyticsGET()).json();
    expect(Array.isArray(body.events)).toBe(true);
  });
  it("includes a taste profile", async () => {
    const body = await (await analyticsGET()).json();
    expect(body.taste).toBeDefined();
  });
});

describe("/api/recommendations", () => {
  it("returns radio tracks and rows", async () => {
    const body = await (await recommendationsGET(new Request("http://localhost/api/recommendations?limit=8"))).json();
    expect(body.radio.length).toBe(8);
    expect(body.rows.length).toBeGreaterThan(0);
  });
  it("honours a seed", async () => {
    const body = await (
      await recommendationsGET(new Request(`http://localhost/api/recommendations?seed=${TRACKS[4].id}&limit=5`))
    ).json();
    expect(body.seed).toBe(TRACKS[4].id);
  });
  it("clamps the limit", async () => {
    const body = await (await recommendationsGET(new Request("http://localhost/api/recommendations?limit=999"))).json();
    expect(body.radio.length).toBeLessThanOrEqual(40);
  });
});

describe("/api/ai/playlist", () => {
  it("builds and saves a playlist from a prompt", async () => {
    const res = await aiPlaylistPOST(json({ prompt: "warm lo-fi to study to, no vocals", size: 6 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tracks).toHaveLength(6);
    expect(body.name.length).toBeGreaterThan(2);
    expect(body.savedPlaylist?.id).toMatch(/^pl_/);
    expect(body.reasoning.length).toBeGreaterThan(0);
  });

  it("can skip saving", async () => {
    const body = await (await aiPlaylistPOST(json({ prompt: "jazz", save: false }))).json();
    expect(body.savedPlaylist).toBeNull();
    expect(body.tracks.length).toBeGreaterThan(0);
  });

  it("requires a prompt", async () => {
    expect((await aiPlaylistPOST(json({}))).status).toBe(400);
  });

  it("clamps the size", async () => {
    const body = await (await aiPlaylistPOST(json({ prompt: "calm", size: 999, save: false }))).json();
    expect(body.tracks.length).toBeLessThanOrEqual(30);
  });

  it("explains each pick", async () => {
    const body = await (await aiPlaylistPOST(json({ prompt: "rainy", save: false }))).json();
    expect(body.scores[0].reasons.length).toBeGreaterThan(0);
    expect(body.scores[0].signals).toBeDefined();
  });
});

describe("/api/stream/[id] quality rungs", () => {
  const firstLine = (bytes: Uint8Array, length = 3) => Buffer.from(bytes.subarray(0, length)).toString("latin1");

  it("serves a tagged MP3 for an MP3 rung", async () => {
    const res = await streamGET(new Request("http://localhost/api/stream/x?q=mp3-32"), params(TRACKS[0].id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-quality")).toBe("mp3-32");
    expect(res.headers.get("x-data-saver")).toBe("true");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(firstLine(bytes)).toBe("ID3");
    expect(bytes.byteLength).toBeGreaterThan(5000);
  }, 30000);

  it("serves a 48 kHz WAV with correct range geometry", async () => {
    const total = await streamHEAD(new Request("http://localhost/api/stream/x?q=wav-48", { method: "HEAD" }), params(TRACKS[0].id));
    const totalBytes = Number(total.headers.get("content-length"));
    expect(total.headers.get("x-quality")).toBe("wav-48");

    const head = await streamGET(
      new Request("http://localhost/api/stream/x?q=wav-48", { headers: { range: "bytes=0-43" } }),
      params(TRACKS[0].id),
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-43/${totalBytes}`);
    const bytes = new Uint8Array(await head.arrayBuffer());
    expect(firstLine(bytes, 4)).toBe("RIFF");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("serves 24-bit WAV masters", async () => {
    const res = await streamHEAD(new Request("http://localhost/api/stream/x?q=wav-48-24", { method: "HEAD" }), params(TRACKS[0].id));
    expect(res.headers.get("x-quality")).toBe("wav-48-24");
    const bytes24 = Number(res.headers.get("content-length"));
    const res16 = await streamHEAD(new Request("http://localhost/api/stream/x?q=wav-48", { method: "HEAD" }), params(TRACKS[0].id));
    const bytes16 = Number(res16.headers.get("content-length"));
    expect(bytes24).toBeGreaterThan(bytes16);
  });

  it("rejects an unknown rung", async () => {
    const res = await streamGET(new Request("http://localhost/api/stream/x?q=kbps-9000"), params(TRACKS[0].id));
    expect(res.status).toBe(400);
  });

  it("serves partial MP3 content when a range is requested", async () => {
    const res = await streamGET(
      new Request("http://localhost/api/stream/x?q=mp3-32", { headers: { range: "bytes=0-511" } }),
      params(BOLLYWOOD_TRACKS[0].id),
    );
    expect(res.status).toBe(206);
    expect(Number(res.headers.get("content-length"))).toBe(512);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-511\/\d+$/);
  }, 30000);
});

describe("/api/download/[id]", () => {
  it("downloads an MP3 with a friendly filename", async () => {
    const res = await downloadFileGET(new Request("http://localhost/api/download/x?q=mp3-32"), params(BOLLYWOOD_TRACKS[0].id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain(".mp3");
    expect(disposition).toContain("filename*=UTF-8''");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 3)).toString("latin1")).toBe("ID3");
  }, 30000);

  it("downloads a WAV at the requested depth", async () => {
    const res = await downloadFileGET(new Request("http://localhost/api/download/x?q=wav-22"), params(TRACKS[0].id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-disposition")).toContain(".wav");
  }, 60000);

  it("404s for an unknown track", async () => {
    const res = await downloadFileGET(new Request("http://localhost/api/download/x"), params("ghost"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/qualities", () => {
  it("lists every audio rung with sizes", async () => {
    const body = await (await qualitiesGET(new Request("http://localhost/api/qualities?id=" + BOLLYWOOD_TRACKS[0].id))).json();
    expect(body.audio.length).toBeGreaterThanOrEqual(8);
    expect(body.default).toBe("mp3-128");
    expect(body.track.id).toBe(BOLLYWOOD_TRACKS[0].id);
    const mp3 = body.audio.filter((entry: { family: string }) => entry.family === "mp3");
    const sizes = mp3.map((entry: { bytes: number }) => entry.bytes);
    expect([...sizes].sort((a: number, b: number) => a - b)).toEqual(sizes);
    for (const entry of body.audio) {
      expect(entry.streamUrl).toContain("?q=");
      expect(entry.downloadUrl).toContain("/api/download/");
    }
  });

  it("lists the video ladder up to 8K", async () => {
    const body = await (await qualitiesGET(new Request("http://localhost/api/qualities"))).json();
    expect(body.video[0].id).toBe("240p");
    expect(body.video.at(-1).id).toBe("8k");
    expect(body.videoExport.clientSide).toBe(true);
  });

  it("404s for an unknown track", async () => {
    const res = await qualitiesGET(new Request("http://localhost/api/qualities?id=ghost"));
    expect(res.status).toBe(404);
  });
});

describe("Bollywood in the catalog API", () => {
  it("ships curated collections", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog"))).json();
    expect(body.collections.length).toBeGreaterThanOrEqual(4);
    const romance = body.collections.find((c: { id: string }) => c.id === "col_bollywood-romance");
    expect(romance.trackIds.length).toBeGreaterThan(2);
  });

  it("gives Hindi film music a permanent home row", async () => {
    const body = await (await recommendationsGET(new Request("http://localhost/api/recommendations"))).json();
    const row = body.rows.find((entry: { title: string }) => entry.title.includes("Bollywood"));
    expect(row).toBeDefined();
    expect(row.tracks.length).toBeGreaterThan(3);
    for (const track of row.tracks) expect(track.genres).toContain("bollywood");
  });

  it("serves Bollywood tracks with native titles", async () => {
    const body = await (await catalogGET(new Request("http://localhost/api/catalog"))).json();
    const hindi = body.tracks.filter((track: { nativeTitle?: string }) => track.nativeTitle);
    expect(hindi.length).toBeGreaterThanOrEqual(10);
  });
});
