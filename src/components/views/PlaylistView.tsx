"use client";

import { useEffect, useState } from "react";
import type { Playlist, Track } from "@/lib/types";
import { usePlayer } from "../PlayerProvider";
import { Cover, EmptyState, TrackRow, formatTime } from "../ui";

export function PlaylistView({ playlistId, onBack }: { playlistId: string; onBack: () => void }) {
  const player = usePlayer();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // The server hydrates catalog *and* saved web songs in playlist order.
      const res = await fetch(`/api/playlists/${playlistId}`);
      if (!alive) return;
      if (!res.ok) {
        setError("Playlist not found");
        return;
      }
      const data = (await res.json()) as { playlist: Playlist; tracks: Track[] };
      setPlaylist(data.playlist);
      setTracks(data.tracks);
    })();
    return () => {
      alive = false;
    };
  }, [playlistId]);

  if (error) return <EmptyState>{error}</EmptyState>;
  if (!playlist) return <EmptyState><span className="spinner" /> Loading playlist…</EmptyState>;

  const total = tracks.reduce((sum, t) => sum + t.duration, 0);
  const webImports = tracks.filter((track) => Boolean(track.web));

  return (
    <div>
      <div className="page-head">
        <div className="inline" style={{ alignItems: "flex-start", gap: 18 }}>
          <Cover palette={playlist.palette} glyph="≣" style={{ width: 132, height: 132, borderRadius: 14 }} />
          <div>
            <button className="btn ghost small" onClick={onBack} style={{ marginBottom: 8 }}>
              ← Back
            </button>
            <h1 className="page-title" style={{ marginBottom: 4 }}>{playlist.name}</h1>
            <p className="page-sub">{playlist.description}</p>
            <div className="inline" style={{ marginTop: 8 }}>
              <span className="badge">{tracks.length} tracks</span>
              <span className="badge">{formatTime(total)}</span>
              {playlist.aiGenerated ? <span className="badge accent">AI generated</span> : null}
            </div>
          </div>
        </div>
        <div className="inline">
          <button className="btn primary" onClick={() => tracks.length && player.playTrack(tracks[0], tracks, "playlist")}>
            ▶ Play
          </button>
          <button
            className="btn"
            onClick={async () => {
              await fetch(`/api/playlists/${playlist.id}`, { method: "DELETE" });
              player.toast(`Deleted “${playlist.name}”`, "ok");
              onBack();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="row-list">
        {tracks.map((track, index) => (
          <TrackRow key={track.id} track={track} index={index} queue={tracks} source="playlist" />
        ))}
      </div>

      {webImports.length ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Imported from the web</h2>
            <span className="section-hint">the original song URL is stored with every entry</span>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {webImports.map((track) => (
              <div className="card" key={track.id} style={{ padding: "10px 14px" }}>
                <div className="row-between" style={{ gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row-title">{track.title}</div>
                    <div className="row-sub">
                      {track.artist} · {track.web?.providerLabel}
                    </div>
                  </div>
                  <a
                    className="btn small ghost"
                    href={track.web?.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={track.web?.sourceUrl}
                    style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {track.web?.sourceUrl}
                  </a>
                </div>
                <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {track.web?.license}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
