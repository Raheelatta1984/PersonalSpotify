"use client";

import { useEffect, useState } from "react";
import type { Playlist, Track } from "@/lib/types";
import { usePlayer } from "../PlayerProvider";
import { Cover, EmptyState, PlaylistCard, Stat, TrackCard } from "../ui";

interface Row {
  title: string;
  tracks: Track[];
}

export function HomeView({ onOpenPlaylist, onNavigate }: { onOpenPlaylist: (id: string) => void; onNavigate: (view: string) => void }) {
  const player = usePlayer();
  const [rows, setRows] = useState<Row[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [stats, setStats] = useState<{ tracks: number; artists: number; totalMinutes: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [recRes, catRes] = await Promise.all([fetch("/api/recommendations"), fetch("/api/catalog")]);
        const rec = (await recRes.json()) as { rows?: Row[] };
        const cat = (await catRes.json()) as { playlists: Playlist[]; stats: { tracks: number; artists: number; totalMinutes: number } };
        if (!alive) return;
        setRows(rec.rows ?? []);
        setPlaylists(cat.playlists.slice(0, 4));
        setStats(cat.stats);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const hero = rows[0]?.tracks[0];

  return (
    <div>
      <section
        className="card"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 220px",
          gap: 22,
          alignItems: "center",
          marginBottom: 26,
          background: "linear-gradient(120deg, rgba(30,215,166,0.14), rgba(124,108,255,0.12))",
          borderColor: "rgba(30,215,166,0.24)",
        }}
      >
        <div>
          <div className="inline" style={{ marginBottom: 10 }}>
            <span className="badge accent">AI-powered</span>
            <span className="badge violet">Listen &amp; identify</span>
            <span className="badge">In-app web browser</span>
          </div>
          <h1 className="page-title" style={{ fontSize: 34, marginBottom: 10 }}>
            Good evening. What should we play?
          </h1>
          <p className="page-sub" style={{ marginBottom: 18 }}>
            Describe the moment — “warm lo-fi for a rainy drive, nothing with vocals” — and SongHub finds it,
            explains why, and starts playing. Or hold up the mic and let it recognise what&apos;s around you.
          </p>
          <div className="inline">
            <button className="btn primary" onClick={() => onNavigate("search")}>
              ✦ Ask for music
            </button>
            <button className="btn" onClick={() => onNavigate("identify")}>
              ◎ Identify a song
            </button>
            {hero ? (
              <button
                className="btn ghost"
                onClick={() => player.playTrack(hero, rows[0].tracks, "home")}
              >
                ▶ Play today&apos;s mix
              </button>
            ) : null}
          </div>
        </div>
        {hero ? <Cover palette={hero.palette} glyph="♫" style={{ width: "100%", aspectRatio: "1", borderRadius: 18 }} /> : null}
      </section>

      {stats ? (
        <div className="stat-grid" style={{ marginBottom: 26 }}>
          <Stat value={stats.tracks} label="Tracks in library" />
          <Stat value={stats.artists} label="Artists" />
          <Stat value={`${stats.totalMinutes}m`} label="Of generated audio" />
          <Stat value="24-bit" label="Fingerprint index" />
        </div>
      ) : null}

      {loading ? (
        <EmptyState>
          <span className="spinner" /> Loading your listening room…
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>Nothing here yet — try asking for music in the search tab.</EmptyState>
      ) : (
        rows.map((row) => (
          <section className="section" key={row.title}>
            <div className="section-head">
              <h2 className="section-title">{row.title}</h2>
              <span className="section-hint">{row.tracks.length} tracks</span>
            </div>
            <div className="grid grid-cards">
              {row.tracks.map((track) => (
                <TrackCard key={`${row.title}-${track.id}`} track={track} queue={row.tracks} source="home" />
              ))}
            </div>
          </section>
        ))
      )}

      {playlists.length ? (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Your playlists</h2>
            <span className="section-hint">curated + AI-made</span>
          </div>
          <div className="grid grid-cards">
            {playlists.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} onOpen={() => onOpenPlaylist(playlist.id)} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
