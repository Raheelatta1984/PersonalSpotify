"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlaybackKind, Playlist, Track, WebSearchHit, WebSearchOutcome, WebTrack } from "@/lib/types";
import { usePlayer } from "./PlayerProvider";
import { Cover, EmptyState, formatTime } from "./ui";

const PLAYBACK_COPY: Record<PlaybackKind, { label: string; badge: string; toast: string }> = {
  full: {
    label: "full recording",
    badge: "accent",
    toast: "Playing the full recording.",
  },
  preview: {
    label: "30 s licensed preview",
    badge: "violet",
    toast: "Playing a licensed 30-second preview — the full track stays with the rights-holder.",
  },
  generated: {
    label: "SongHub preview",
    badge: "warn",
    toast: "No licensed recording was available, so SongHub is playing its own 30-second synth preview.",
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^songhub:\/\//, "");
  }
}

function paletteFor(seed: string): [string, string] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hue = hash % 360;
  return [`hsl(${hue} 78% 58%)`, `hsl(${(hue + 36) % 360} 62% 26%)`];
}

export function WebMusicPanel({ initialQuery, autoRun = false }: { initialQuery?: string; autoRun?: boolean }) {
  const player = usePlayer();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [siteOnly, setSiteOnly] = useState(false);
  const [outcome, setOutcome] = useState<WebSearchOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<WebTrack[]>([]);
  const [savedTracks, setSavedTracks] = useState<Track[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [lastPlayed, setLastPlayed] = useState<{ title: string; kind: PlaybackKind; license: string } | null>(null);

  const loadPlaylists = useCallback(async () => {
    try {
      const res = await fetch("/api/playlists");
      const data = (await res.json()) as { playlists: Playlist[] };
      setPlaylists(data.playlists);
    } catch {
      /* offline */
    }
  }, []);

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch("/api/web/tracks");
      const data = (await res.json()) as { webTracks: WebTrack[]; tracks: Track[] };
      setSaved(data.webTracks ?? []);
      setSavedTracks(data.tracks ?? []);
      setSavedIds(new Set((data.webTracks ?? []).map((track) => track.sourceUrl)));
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void loadPlaylists();
    void loadSaved();
  }, [loadPlaylists, loadSaved]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) return;
      setLoading(true);
      try {
        const res = await fetch("/api/web/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q, limit: 16, siteOnly }),
        });
        setOutcome((await res.json()) as WebSearchOutcome);
      } catch {
        player.toast("Web music search failed", "err");
      } finally {
        setLoading(false);
      }
    },
    [player, siteOnly],
  );

  useEffect(() => {
    if (autoRun && initialQuery?.trim()) void runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, initialQuery]);

  /** Save the hit (real title + URL) and start playback inside SongHub. */
  async function playHit(hit: WebSearchHit) {
    setBusy(hit.id);
    try {
      const res = await fetch("/api/web/play", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hit }),
      });
      const payload = (await res.json()) as { track?: Track; webTrack?: WebTrack; error?: string };
      if (!res.ok || !payload.track) throw new Error(payload.error ?? "Could not resolve this song");
      player.playTrack(payload.track, [payload.track], "online");
      const kind = payload.webTrack?.playbackKind ?? "generated";
      setLastPlayed({
        title: payload.webTrack?.title ?? hit.title,
        kind,
        license: payload.webTrack?.license ?? "unknown",
      });
      player.toast(`${payload.track.title} — ${PLAYBACK_COPY[kind].toast}`, kind === "generated" ? "info" : "ok");
      void loadSaved();
    } catch (error) {
      player.toast(error instanceof Error ? error.message : "Could not play that song", "err");
    } finally {
      setBusy(null);
    }
  }

  /** Save the hit and append it to a playlist in one round-trip. */
  async function addToPlaylist(hit: WebSearchHit, playlistId: string | undefined) {
    setBusy(`add:${hit.id}`);
    try {
      let target = playlistId;
      if (!target) {
        // "New playlist" — name it after the song so the entry is self-describing.
        const created = await fetch("/api/playlists", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `${hit.title} — ${hit.artist}`.slice(0, 90), description: "Saved from the web" }),
        });
        const playlist = (await created.json()) as Playlist;
        target = playlist.id;
      }
      const res = await fetch(`/api/playlists/${target}/tracks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hit }),
      });
      const payload = (await res.json()) as {
        playlist?: Playlist;
        added?: boolean;
        track?: Track;
        savedSourceUrl?: string;
        error?: string;
      };
      if (!res.ok || !payload.playlist) throw new Error(payload.error ?? "Could not add to playlist");
      const title = payload.track?.title ?? hit.title;
      const url = payload.savedSourceUrl ?? hit.sourceUrl;
      player.toast(
        payload.added
          ? `Added “${title}” to “${payload.playlist.name}” — saved with its song URL (${hostOf(url)}).`
          : `“${title}” is already in “${payload.playlist.name}”.`,
        "ok",
      );
      await loadPlaylists();
      await loadSaved();
    } catch (error) {
      player.toast(error instanceof Error ? error.message : "Could not add to playlist", "err");
    } finally {
      setBusy(null);
    }
  }

  async function removeSaved(id: string) {
    const res = await fetch(`/api/web/tracks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      player.toast("Removed from the web library.", "info");
      await loadSaved();
    }
  }

  const providers = outcome?.providers ?? [];
  const hitCount = outcome?.hits.length ?? 0;
  const firstPlaylist = playlists[0]?.id;

  const savedCards = useMemo(() => saved.slice(0, 24), [saved]);
  const savedTrackById = useMemo(() => new Map(savedTracks.map((track) => [track.id, track])), [savedTracks]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <form
        className="search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <input
          className="input"
          placeholder="Search every song on mp3juice.sc — title, artist or lyric…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="btn primary" type="submit" disabled={loading || !query.trim()}>
          {loading ? <span className="spinner" /> : "Search music"}
        </button>
      </form>

      <div className="inline" style={{ gap: 10, flexWrap: "wrap" }}>
        <label className="inline dim" style={{ gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={siteOnly} onChange={(event) => setSiteOnly(event.target.checked)} />
          mp3juice.sc only (no web fallback)
        </label>
        <span className="dim" style={{ fontSize: 12 }}>
          Results are metadata; playback uses officially licensed previews or openly licensed audio.
        </span>
      </div>

      {outcome?.notice ? <div className="notice">{outcome.notice}</div> : null}

      {outcome ? (
        <div className="inline" style={{ gap: 6, flexWrap: "wrap" }}>
          {providers.map((provider) => (
            <span
              key={provider.provider}
              className={`badge ${provider.ok && provider.count ? "accent" : ""}`}
              title={provider.error ?? `${provider.count} results in ${provider.tookMs}ms`}
            >
              {provider.provider} {provider.ok ? `· ${provider.count}` : "· no results"}
            </span>
          ))}
          <span className="dim" style={{ fontSize: 11.5 }}>
            {hitCount} songs in {outcome.tookMs} ms · {outcome.live ? "live web" : "offline demo"}
          </span>
        </div>
      ) : null}

      {lastPlayed ? (
        <div
          className="card"
          style={{ padding: "10px 14px", borderColor: "rgba(89,212,181,0.35)", background: "rgba(89,212,181,0.07)" }}
        >
          <div className="inline" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={`badge ${PLAYBACK_COPY[lastPlayed.kind].badge}`}>
              {PLAYBACK_COPY[lastPlayed.kind].label}
            </span>
            <span style={{ fontSize: 12.5 }}>
              Now playing <strong>{lastPlayed.title}</strong>
            </span>
            <span className="dim" style={{ fontSize: 11.5 }}>
              {lastPlayed.license}
            </span>
          </div>
        </div>
      ) : null}

      {loading ? (
        <EmptyState>
          <span className="spinner" /> Scraping mp3juice.sc…
        </EmptyState>
      ) : outcome?.hits.length ? (
        <div className="stack" style={{ gap: 10 }}>
          {outcome.hits.map((hit) => {
            const palette = paletteFor(`${hit.title}|${hit.artist}`);
            const isSaved = savedIds.has(hit.sourceUrl);
            const selected = choice[hit.id] ?? firstPlaylist ?? "";
            return (
              <div className="card" key={hit.id} style={{ padding: 14 }}>
                <div className="inline" style={{ gap: 12, alignItems: "flex-start" }}>
                  {hit.artworkUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={hit.artworkUrl}
                      alt=""
                      width={56}
                      height={56}
                      referrerPolicy="no-referrer"
                      style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover", flex: "0 0 auto" }}
                    />
                  ) : (
                    <Cover palette={palette} glyph="♫" style={{ width: 56, height: 56, borderRadius: 8, flex: "0 0 auto" }} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row-title">{hit.title}</div>
                    <div className="row-sub">
                      {hit.artist}
                      {hit.album ? ` · ${hit.album}` : ""}
                    </div>
                    <div className="inline" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <span className="badge violet">{hit.providerLabel}</span>
                      {hit.durationSec ? <span className="badge">{formatTime(hit.durationSec)}</span> : null}
                      <span className="badge" title={hit.sourceUrl}>
                        {hostOf(hit.sourceUrl)}
                      </span>
                      {hit.playbackKind ? (
                        <span className={`badge ${PLAYBACK_COPY[hit.playbackKind].badge}`}>
                          {PLAYBACK_COPY[hit.playbackKind].label}
                        </span>
                      ) : null}
                      {isSaved ? <span className="badge accent">saved</span> : null}
                    </div>
                  </div>
                </div>

                {hit.notes ? (
                  <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
                    {hit.notes}
                  </div>
                ) : null}

                <div className="inline" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
                  <button className="btn small primary" onClick={() => void playHit(hit)} disabled={busy === hit.id}>
                    {busy === hit.id ? <span className="spinner" /> : "▶ Play"}
                  </button>

                  <select
                    className="input"
                    aria-label={`Playlist for ${hit.title}`}
                    style={{ width: "auto", padding: "6px 8px", fontSize: 12.5 }}
                    value={selected}
                    onChange={(event) => setChoice((prev) => ({ ...prev, [hit.id]: event.target.value }))}
                  >
                    {playlists.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </option>
                    ))}
                    <option value="">＋ New playlist</option>
                  </select>
                  <button
                    className="btn small"
                    onClick={() => void addToPlaylist(hit, choice[hit.id] ?? firstPlaylist)}
                    disabled={busy === `add:${hit.id}`}
                  >
                    {busy === `add:${hit.id}` ? <span className="spinner" /> : "＋ Add to playlist"}
                  </button>

                  <a
                    className="btn small ghost"
                    href={hit.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={hit.sourceUrl}
                  >
                    Open source ↗
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      ) : outcome ? (
        <EmptyState>No songs matched “{outcome.query}”. Try the artist plus a word from the title.</EmptyState>
      ) : (
        <EmptyState>
          Search mp3juice.sc for any song. Play it right here, or add it to a playlist — the real title and the song
          URL are stored together.
        </EmptyState>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Saved from the web</h2>
          <span className="section-hint">{saved.length} songs · titles and source URLs kept</span>
        </div>
        {savedCards.length ? (
          <div className="row-list">
            {savedCards.map((track) => (
              <div className="track-row" key={track.id} style={{ gridTemplateColumns: "44px 1fr auto", alignItems: "center" }}>
                <Cover palette={track.palette} glyph="♫" style={{ width: 36, height: 36, borderRadius: 7 }} />
                <div className="row-main">
                  <div className="row-title">{track.title}</div>
                  <div className="row-sub">
                    {track.artist} · {track.providerLabel} ·{" "}
                    <a href={track.sourceUrl} target="_blank" rel="noreferrer noopener" title={track.sourceUrl}>
                      {hostOf(track.sourceUrl)}
                    </a>
                  </div>
                </div>
                <div className="inline">
                  <span className={`badge ${PLAYBACK_COPY[track.playbackKind].badge}`}>
                    {PLAYBACK_COPY[track.playbackKind].label}
                  </span>
                  <button
                    className="btn small"
                    onClick={() => {
                      const playable = savedTrackById.get(track.id);
                      if (playable) player.playTrack(playable, [playable], "online");
                      else void playHit({
                        id: track.id,
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                        durationSec: track.durationSec,
                        artworkUrl: track.artworkUrl,
                        sourceUrl: track.sourceUrl,
                        provider: track.provider,
                        providerLabel: track.providerLabel,
                        confidence: 0.9,
                      });
                    }}
                  >
                    ▶
                  </button>
                  <a className="btn small ghost" href={`/api/stream/${track.id}`} target="_blank" rel="noreferrer">
                    stream
                  </a>
                  <button className="icon-btn" aria-label={`Remove ${track.title}`} onClick={() => void removeSaved(track.id)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>Nothing saved yet — play or add a song and it lands here with its original URL.</EmptyState>
        )}
      </section>
    </div>
  );
}
