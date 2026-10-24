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
      const [plRes, catRes] = await Promise.all([fetch("/api/playlists"), fetch("/api/catalog")]);
      const plData = (await plRes.json()) as { playlists: Playlist[] };
      const cat = (await catRes.json()) as { tracks: Track[] };
      if (!alive) return;
      const found = plData.playlists.find((p) => p.id === playlistId);
      if (!found) {
        setError("Playlist not found");
        return;
      }
      setPlaylist(found);
      setTracks(found.trackIds.map((id) => cat.tracks.find((t) => t.id === id)).filter((t): t is Track => Boolean(t)));
    })();
    return () => {
      alive = false;
    };
  }, [playlistId]);

  if (error) return <EmptyState>{error}</EmptyState>;
  if (!playlist) return <EmptyState><span className="spinner" /> Loading playlist…</EmptyState>;

  const total = tracks.reduce((sum, t) => sum + t.duration, 0);

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
    </div>
  );
}
