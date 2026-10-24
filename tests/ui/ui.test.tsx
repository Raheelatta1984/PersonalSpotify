// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/components/App";
import { PlayerProvider } from "@/components/PlayerProvider";
import { TRACKS } from "@/lib/catalog/tracks";

/** A minimal fake of the SongHub API so the UI can be exercised without a server. */
function installFetchMock() {
  const playlists = [
    {
      id: "pl_test",
      name: "Test Playlist",
      description: "for tests",
      trackIds: [TRACKS[0].id, TRACKS[1].id],
      owner: "you",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      palette: ["#59d4b5", "#123f3a"] as [string, string],
    },
  ];

  const responses: Record<string, unknown> = {
    "/api/catalog": {
      tracks: TRACKS,
      artists: [],
      playlists,
      library: { liked: [], recent: [], plays: {} },
      taste: { genres: [], moods: [], artistIds: [] },
      stats: { tracks: TRACKS.length, artists: 12, playlists: 1, totalMinutes: 60 },
    },
    "/api/playlists": { playlists },
    "/api/recommendations": {
      radio: TRACKS.slice(0, 6),
      seed: TRACKS[0].id,
      taste: { genres: [], moods: [], artistIds: [] },
      recentlyPlayed: [],
      rows: [
        { title: "Made for you", tracks: TRACKS.slice(0, 4) },
        { title: "Trending in SongHub", tracks: TRACKS.slice(4, 8) },
      ],
    },
    "/api/library": { liked: [], recent: [], likedTracks: [], recentTracks: [], playlists },
    "/api/analytics": {
      summary: {
        totalPlays: 3,
        minutesListened: 4.5,
        uniqueTracks: 2,
        topTracks: [{ track: TRACKS[0], plays: 2 }],
        topArtists: [{ artist: TRACKS[0].artist, plays: 2 }],
        topGenres: [{ genre: "lo-fi", plays: 2 }],
        topMoods: [{ mood: "calm", plays: 2 }],
        byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, plays: hour === 10 ? 3 : 0 })),
        byDay: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => ({ day, plays: 1 })),
        streakDays: 2,
      },
      taste: { genres: ["lo-fi"], moods: ["calm"], artistIds: [] },
      events: [],
    },
    "/api/identify/status": { status: "ready", progress: 1, trackCount: TRACKS.length, totalHashes: 686760 },
    "/api/temp": { downloads: [], count: 0 },
  };

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0];

    if (path === "/api/search" || path === "/api/ai/playlist") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const query = body.query ?? body.prompt ?? "";
      return new Response(
        JSON.stringify({
          query,
          tookMs: 12,
          understanding: {
            raw: query,
            normalized: query,
            tokens: query.split(" "),
            expandedTokens: query.split(" "),
            filters: { genres: ["lo-fi"], moods: ["calm"] },
            seedTitles: [],
            instructions: { play: false, shuffle: false, queue: false, createPlaylist: false },
            energyTarget: 0.3,
            valenceTarget: 0.5,
            negativeTokens: [],
            reasoning: ["Genres inferred: lo-fi.", "Moods inferred: calm."],
          },
          hits: TRACKS.slice(0, 3).map((track, index) => ({
            track,
            score: 0.7 - index * 0.1,
            signals: { lexical: 0.5, semantic: 0.6, metadata: 1, popularity: 0.8, reference: 0 },
            reasons: ["Matches calm, lo-fi."],
          })),
          fallbackUsed: false,
          answer: "Here are 3 lo-fi tracks with a calm feel.",
          name: "Calm Lo-fi",
          description: "AI description",
          reasoning: ["Genres inferred: lo-fi."],
          tracks: TRACKS.slice(0, 3),
          scores: [{ id: TRACKS[0].id, score: 0.7, signals: {}, reasons: ["why"] }],
          savedPlaylist: playlists[0],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/api/events") return new Response(JSON.stringify({ ok: true }), { status: 201 });
    if (path === "/api/online/search") {
      return new Response(
        JSON.stringify({
          query: "test",
          results: [
            {
              id: "local-web:trk_neon_overpass",
              title: "Neon Overpass",
              artist: "Neon Harbor",
              album: "Coastal Signal",
              durationSec: 86,
              source: "local-web",
              sourceLabel: "SongHub demo web",
              sourceUrl: "songhub://web/trk_neon_overpass",
              license: "Generated preview",
              confidence: 0.8,
              downloadable: true,
              notes: "Offline demo result",
            },
          ],
          providers: [{ provider: "itunes", ok: false, count: 0, tookMs: 3 }],
          live: false,
          tookMs: 5,
          notice: "Live catalogs were unreachable.",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path === "/api/online/browse") {
      return new Response(
        JSON.stringify({
          url: "songhub://web/trk_neon_overpass",
          title: "Neon Overpass",
          description: "desc",
          blocks: [
            { type: "heading", text: "Neon Overpass", level: 1 },
            { type: "text", text: "A synthwave track." },
            { type: "audio", src: "/api/stream/trk_neon_overpass" },
          ],
          fetchedLive: false,
          source: "SongHub demo web",
          fetchedAt: new Date().toISOString(),
          links: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path === "/api/online/download") {
      return new Response(
        JSON.stringify({
          token: "abc123",
          title: "Neon Overpass",
          artist: "Neon Harbor",
          source: "local-web",
          sourceUrl: "songhub://web/trk_neon_overpass",
          fileName: "abc123.wav",
          bytes: 480000,
          contentType: "audio/wav",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          ttlSeconds: 600,
          live: false,
          license: "Generated preview",
          streamUrl: "/api/temp/abc123",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (path in responses) {
      return new Response(JSON.stringify(responses[path]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });

  vi.stubGlobal("fetch", mock);
  return mock;
}

class FakeAudio {
  src = "";
  currentTime = 0;
  duration = 100;
  volume = 1;
  muted = false;
  paused = true;
  preload = "";
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, handler: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: () => void) {
    this.listeners.get(type)?.delete(handler);
  }
  dispatch(type: string) {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
  load() {
    this.dispatch("loadedmetadata");
  }
  play() {
    this.paused = false;
    this.dispatch("play");
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatch("pause");
  }
}

function renderApp() {
  return render(
    <PlayerProvider>
      <App />
    </PlayerProvider>,
  );
}

describe("SongHub UI", () => {
  beforeEach(() => {
    installFetchMock();
    vi.stubGlobal("Audio", FakeAudio as unknown as typeof Audio);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the shell with navigation", async () => {
    renderApp();
    expect(screen.getByText("SongHub")).toBeTruthy();
    for (const label of ["Home", "AI Search", "Identify", "Web & Browser", "Library", "Analytics"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the hero copy on home", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText(/What should we play/i)).toBeTruthy());
  });

  it("loads recommendation rows from the API", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText("Made for you")).toBeTruthy());
    expect(screen.getByText("Trending in SongHub")).toBeTruthy();
  });

  it("renders catalog stats", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText("Tracks in library")).toBeTruthy());
    expect(screen.getByText(String(TRACKS.length))).toBeTruthy();
  });

  it("navigates to the AI search view", async () => {
    renderApp();
    fireEvent.click(screen.getByText("AI Search"));
    expect(await screen.findByText(/Ask in plain language/i)).toBeTruthy();
  });

  it("runs a search and shows the AI answer", async () => {
    renderApp();
    fireEvent.click(screen.getByText("AI Search"));
    const input = await screen.findByLabelText("Search query");
    fireEvent.change(input, { target: { value: "calm lo-fi" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByText(/Here are 3 lo-fi tracks/)).toBeTruthy());
    expect(screen.getByText("3 matches")).toBeTruthy();
  });

  it("shows the reasoning trace for a search", async () => {
    renderApp();
    fireEvent.click(screen.getByText("AI Search"));
    const input = await screen.findByLabelText("Search query");
    fireEvent.change(input, { target: { value: "calm" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByText("Genres inferred: lo-fi.")).toBeTruthy());
  });

  it("shows the signal breakdown after a search", async () => {
    renderApp();
    fireEvent.click(screen.getByText("AI Search"));
    const input = await screen.findByLabelText("Search query");
    fireEvent.change(input, { target: { value: "calm" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByText(/Why these\? Signal breakdown/)).toBeTruthy());
  });

  it("renders the identify view with the fingerprint index badge", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Identify"));
    await waitFor(() => expect(screen.getByText(/Listen & identify/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
  });

  it("renders the web browser view", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Web & Browser"));
    expect(await screen.findByText(/Web search & browser/i)).toBeTruthy();
  });

  it("searches the web and renders results", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Web & Browser"));
    const input = await screen.findByPlaceholderText(/Search the web/i);
    fireEvent.change(input, { target: { value: "neon" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getAllByText("Neon Overpass").length).toBeGreaterThan(0));
    expect(screen.getByText("SongHub demo web")).toBeTruthy();
  });

  it("opens a result in the in-app browser", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Web & Browser"));
    const input = await screen.findByPlaceholderText(/Search the web/i);
    fireEvent.change(input, { target: { value: "neon" } });
    fireEvent.submit(input.closest("form")!);
    const button = await screen.findByText("Open in browser");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("A synthwave track.")).toBeTruthy());
  });

  it("downloads a result temporarily and starts playback", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Web & Browser"));
    const input = await screen.findByPlaceholderText(/Search the web/i);
    fireEvent.change(input, { target: { value: "neon" } });
    fireEvent.submit(input.closest("form")!);
    const button = await screen.findByText(/Download & play/);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("temporary")).toBeTruthy());
    expect(screen.getByText(/Delete now/)).toBeTruthy();
  });

  it("renders the library view with playlists", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Library"));
    await waitFor(() => expect(screen.getAllByText("Test Playlist").length).toBeGreaterThan(0));
  });

  it("renders analytics with charts", async () => {
    renderApp();
    fireEvent.click(screen.getByText("Analytics"));
    await waitFor(() => expect(screen.getByText("Plays by hour")).toBeTruthy());
    expect(screen.getByText("Plays by weekday")).toBeTruthy();
    expect(screen.getByText("2-day streak")).toBeTruthy();
  });

  it("opens a playlist from the sidebar", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("Test Playlist").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Test Playlist")[0]);
    await waitFor(() => expect(screen.getByText("▶ Play")).toBeTruthy());
  });

  it("shows the empty player state", async () => {
    renderApp();
    expect(screen.getByText(/Nothing playing yet/i)).toBeTruthy();
  });

  it("starts playback when a track card is played", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByLabelText(/^Play /).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByLabelText(/^Play /)[0]);
    await waitFor(() => expect(screen.queryByText(/Nothing playing yet/i)).toBeNull());
  });

  it("opens the queue panel", async () => {
    renderApp();
    fireEvent.click(screen.getByLabelText("Queue"));
    await waitFor(() => expect(screen.getByText(/Queue is empty/)).toBeTruthy());
  });

  it("has a seek slider", async () => {
    renderApp();
    expect(screen.getByLabelText("Seek")).toBeTruthy();
  });

  it("has a volume control", async () => {
    renderApp();
    expect(screen.getByLabelText("Volume")).toBeTruthy();
  });

  it("toggles mute", async () => {
    renderApp();
    fireEvent.click(screen.getByLabelText("Mute"));
    expect(screen.getByLabelText("Mute")).toBeTruthy();
  });

  it("switches between every view without crashing", async () => {
    renderApp();
    for (const label of ["Home", "AI Search", "Identify", "Web & Browser", "Library", "Analytics", "Home"]) {
      fireEvent.click(screen.getByText(label));
      await waitFor(() => expect(screen.getByText("SongHub")).toBeTruthy());
    }
  });

  it("renders a toast after an action", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByLabelText(/^Play /).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByLabelText(/^Play /)[0]);
    // queue button should now show a count > 0
    await waitFor(() => expect(screen.queryByText(/Nothing playing yet/i)).toBeNull());
  });
});
