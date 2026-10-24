"use client";

import { useCallback, useEffect, useState } from "react";
import type { Playlist, Track } from "@/lib/types";
import { usePlayer } from "./PlayerProvider";
import { PlayerBar } from "./PlayerBar";
import { Cover, trackIndex } from "./ui";
import { HomeView } from "./views/HomeView";
import { SearchView } from "./views/SearchView";
import { IdentifyView } from "./views/IdentifyView";
import { OnlineView } from "./views/OnlineView";
import { LibraryView } from "./views/LibraryView";
import { AnalyticsView } from "./views/AnalyticsView";
import { PlaylistView } from "./views/PlaylistView";

type View = "home" | "search" | "identify" | "online" | "library" | "analytics" | "playlist";

const NAV: { id: View; label: string; icon: string; badge?: string }[] = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "search", label: "AI Search", icon: "✦", badge: "AI" },
  { id: "identify", label: "Identify", icon: "◎", badge: "mic" },
  { id: "online", label: "Web & Browser", icon: "⇗" },
  { id: "library", label: "Library", icon: "♫" },
  { id: "analytics", label: "Analytics", icon: "▤" },
];

export function App() {
  const player = usePlayer();
  const [view, setView] = useState<View>("home");
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);

  const refreshPlaylists = useCallback(async () => {
    try {
      const res = await fetch("/api/playlists");
      const data = (await res.json()) as { playlists: Playlist[] };
      setPlaylists(data.playlists);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/catalog");
        const data = (await res.json()) as { tracks: Track[]; playlists: Playlist[] };
        for (const track of data.tracks) trackIndex.set(track.id, track);
        setPlaylists(data.playlists);
      } catch {
        /* offline */
      }
    })();
  }, []);

  useEffect(() => {
    if (view === "library" || view === "home") void refreshPlaylists();
  }, [view, refreshPlaylists]);

  const openPlaylist = (id: string) => {
    setPlaylistId(id);
    setView("playlist");
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div className="brand-text">
            <div className="brand-name">SongHub</div>
            <div className="brand-sub">personal spotify</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => setView(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div>
          <div className="sidebar-section-title">Playlists</div>
          <div className="stack" style={{ gap: 2, marginTop: 6 }}>
            {playlists.slice(0, 8).map((playlist) => (
              <button
                key={playlist.id}
                className={`playlist-mini ${view === "playlist" && playlistId === playlist.id ? "active" : ""}`}
                onClick={() => openPlaylist(playlist.id)}
              >
                <Cover palette={playlist.palette} className="mini-art" style={{ width: 30, height: 30 }} glyph="≣" />
                <span className="mini-meta">
                  <span className="mini-name">{playlist.name}</span>
                  <span className="mini-count">{playlist.trackIds.length} tracks</span>
                </span>
              </button>
            ))}
            {playlists.length === 0 ? <span className="dim" style={{ fontSize: 12, padding: "6px 8px" }}>No playlists yet</span> : null}
          </div>
        </div>

        <div className="sidebar-foot">
          <div className="now-playing-strip">
            {player.playing ? (
              <div className="equalizer" aria-hidden>
                <span /> <span /> <span /> <span />
              </div>
            ) : (
              <span>◌</span>
            )}
            <span>{player.current ? `Now playing` : "Idle"}</span>
          </div>
          <div style={{ marginTop: 8, lineHeight: 1.5 }}>
            Every track is synthesised on request — no audio files, no licensing, byte-identical playback.
          </div>
        </div>
      </aside>

      <main className="main">
        {view === "home" ? <HomeView onOpenPlaylist={openPlaylist} onNavigate={(v) => setView(v as View)} /> : null}
        {view === "search" ? <SearchView /> : null}
        {view === "identify" ? <IdentifyView /> : null}
        {view === "online" ? <OnlineView /> : null}
        {view === "library" ? <LibraryView onOpenPlaylist={openPlaylist} /> : null}
        {view === "analytics" ? <AnalyticsView /> : null}
        {view === "playlist" && playlistId ? <PlaylistView playlistId={playlistId} onBack={() => setView("library")} /> : null}
      </main>

      {player.queueOpen ? (
        <div className="queue-panel">
          <div className="row-between" style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Queue · {player.queue.length}</strong>
            <div className="inline">
              <button className="btn small ghost" onClick={player.clearQueue}>
                Clear
              </button>
              <button className="btn small ghost" onClick={() => player.setQueueOpen(false)}>
                ✕
              </button>
            </div>
          </div>
          <div className="row-list">
            {player.queue.map((item, index) => (
              <div key={`${item.src}-${index}`} className={`track-row ${player.current?.src === item.src ? "active" : ""}`} style={{ gridTemplateColumns: "22px 1fr auto" }}>
                <span className="row-index">{index + 1}</span>
                <div className="row-main">
                  <div className="row-title">{item.title}</div>
                  <div className="row-sub">{item.artist}{item.origin === "temp" ? " · temp" : ""}</div>
                </div>
                <button className="icon-btn" onClick={() => player.removeFromQueue(index)} aria-label="Remove from queue">
                  ✕
                </button>
              </div>
            ))}
            {player.queue.length === 0 ? <div className="empty">Queue is empty</div> : null}
          </div>
        </div>
      ) : null}

      <div className="toast-stack">
        {player.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>

      <PlayerBar />
    </div>
  );
}
