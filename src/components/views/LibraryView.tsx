"use client";

import { useEffect, useState } from "react";
import type { Playlist, Track } from "@/lib/types";
import { usePlayer } from "../PlayerProvider";
import { Cover, EmptyState, PlaylistCard, TrackRow, formatTime } from "../ui";

interface LibraryResponse {
  liked: string[];
  recent: string[];
  likedTracks: Track[];
  recentTracks: Track[];
  playlists: Playlist[];
}

export function LibraryView({ onOpenPlaylist }: { onOpenPlaylist: (id: string) => void }) {
  const player = usePlayer();
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{ name: string; description: string; tracks: Track[]; reasoning: string[] } | null>(null);

  const load = async () => {
    const res = await fetch("/api/library");
    setData((await res.json()) as LibraryResponse);
  };

  useEffect(() => {
    void load();
  }, []);

  async function generatePlaylist() {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/ai/playlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt, size: 10 }),
      });
      const payload = (await res.json()) as { name: string; description: string; tracks: Track[]; reasoning: string[] };
      setGenerated(payload);
      await load();
      player.toast(`Created “${payload.name}” with ${payload.tracks.length} tracks`, "ok");
    } finally {
      setGenerating(false);
    }
  }

  if (!data) return <EmptyState><span className="spinner" /> Loading library…</EmptyState>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Your library</h1>
          <p className="page-sub">Liked tracks, recent plays, and playlists — including ones the AI built for you.</p>
        </div>
        <div className="inline">
          <span className="badge">{data.liked.length} liked</span>
          <span className="badge">{data.recent.length} recent</span>
          <span className="badge accent">{data.playlists.length} playlists</span>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">✦ Make a playlist with AI</h2>
          <span className="section-hint">one sentence is enough</span>
        </div>
        <div className="search-bar">
          <input
            className="input"
            placeholder="e.g. 40 minutes of focus music, no vocals, nothing above 100 BPM"
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void generatePlaylist();
            }}
          />
          <button className="btn primary" onClick={() => void generatePlaylist()} disabled={generating || !aiPrompt.trim()}>
            {generating ? <span className="spinner" /> : "Generate"}
          </button>
        </div>
        {generated ? (
          <div className="answer" style={{ marginTop: 14 }}>
            <div className="answer-icon">✦</div>
            <div style={{ width: "100%" }}>
              <p className="answer-text">
                <strong>{generated.name}</strong> — {generated.description}
              </p>
              <div className="row-list" style={{ marginTop: 10 }}>
                {generated.tracks.slice(0, 5).map((track, index) => (
                  <TrackRow key={track.id} track={track} index={index} queue={generated.tracks} source="queue" />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Playlists</h2>
          <span className="section-hint">{formatTime(data.playlists.reduce((sum, p) => sum + p.trackIds.length * 90, 0))} of music</span>
        </div>
        {data.playlists.length ? (
          <div className="grid grid-cards">
            {data.playlists.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} onOpen={() => onOpenPlaylist(playlist.id)} />
            ))}
          </div>
        ) : (
          <EmptyState>No playlists yet — ask the AI for one above.</EmptyState>
        )}
      </section>

      <div className="grid grid-2">
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Liked</h2>
            <button
              className="btn small"
              disabled={!data.likedTracks.length}
              onClick={() => data.likedTracks.length && player.playTrack(data.likedTracks[0], data.likedTracks, "library")}
            >
              ▶ Play all
            </button>
          </div>
          {data.likedTracks.length ? (
            <div className="row-list">
              {data.likedTracks.map((track, index) => (
                <TrackRow key={track.id} track={track} index={index} queue={data.likedTracks} source="library" />
              ))}
            </div>
          ) : (
            <EmptyState>Tap ♥ on any track to keep it here.</EmptyState>
          )}
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Recently played</h2>
            <span className="section-hint">{data.recentTracks.length} tracks</span>
          </div>
          {data.recentTracks.length ? (
            <div className="row-list">
              {data.recentTracks.slice(0, 10).map((track, index) => (
                <TrackRow key={track.id} track={track} index={index} queue={data.recentTracks} source="library" />
              ))}
            </div>
          ) : (
            <EmptyState>Play something and it will show up here.</EmptyState>
          )}
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Covers</h2>
          <span className="section-hint">generated from each track&apos;s palette</span>
        </div>
        <div className="inline">
          {data.playlists.slice(0, 8).map((playlist) => (
            <Cover key={playlist.id} palette={playlist.palette} glyph="≣" style={{ width: 64, height: 64, borderRadius: 10 }} />
          ))}
        </div>
      </section>
    </div>
  );
}
