"use client";

import { useEffect, useMemo, useState } from "react";
import type { Track } from "@/lib/types";
import { formatBytes, estimateBytes, qualityOr } from "@/lib/audio/quality";
import { usePlayer } from "../PlayerProvider";
import { QualitySelect } from "../QualityPanel";
import { Cover, EmptyState, formatTime } from "../ui";

interface Collection {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
  trackIds: string[];
}

type Scene = "all" | "romance" | "sangeet" | "barsaat" | "sufi";

const SCENES: { id: Scene; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "romance", label: "Romance" },
  { id: "sangeet", label: "Sangeet & dance" },
  { id: "barsaat", label: "Barsaat · sad" },
  { id: "sufi", label: "Sufi & ghazal" },
];

const QUICK_RUNGS = ["mp3-64", "mp3-128", "mp3-320", "wav-48"];

function matchesScene(track: Track, scene: Scene): boolean {
  if (scene === "all") return true;
  if (scene === "romance") return track.moods.includes("romantic");
  if (scene === "sangeet") return track.moods.includes("energetic") || track.tags.includes("wedding");
  if (scene === "barsaat") return track.tags.includes("rain") || track.moods.includes("melancholic");
  return track.genres.includes("sufi");
}

/**
 * Bollywood & filmi shelf.
 *
 * Every song here is an original filmi-style arrangement synthesised by
 * SongHub — no film audio is copied — so the whole ladder (MP3 32 kbps …
 * 8K MP4) is available on material we actually own the rights to.
 */
export function BollywoodView() {
  const player = usePlayer();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [scene, setScene] = useState<Scene>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/catalog");
        const data = (await res.json()) as { tracks: Track[]; collections?: Collection[] };
        if (!alive) return;
        setTracks(data.tracks.filter((track) => track.language === "hi" || track.genres.includes("bollywood") || track.genres.includes("sufi")));
        setCollections(data.collections ?? []);
      } catch {
        /* offline */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const byId = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const filtered = useMemo(() => tracks.filter((track) => matchesScene(track, scene)), [tracks, scene]);
  const quality = qualityOr(player.quality);

  const shelves = useMemo(() => {
    const list = collections
      .map((collection) => ({
        ...collection,
        tracks: collection.trackIds.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track)),
      }))
      .filter((collection) => collection.tracks.length > 0);
    return list;
  }, [collections, byId]);

  const playAll = () => {
    if (filtered.length) player.playTrack(filtered[0], filtered, "home");
  };

  return (
    <div>
      <section
        className="card"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 220px",
          gap: 22,
          alignItems: "center",
          marginBottom: 20,
          background: "linear-gradient(120deg, rgba(255,138,61,0.16), rgba(255,92,122,0.12))",
          borderColor: "rgba(255,138,61,0.28)",
        }}
      >
        <div>
          <div className="inline" style={{ marginBottom: 10 }}>
            <span className="badge accent">हिंदी · Bollywood</span>
            <span className="badge violet">filmi arrangements</span>
            <span className="badge">MP3 · WAV · MP4</span>
          </div>
          <h1 className="page-title" style={{ fontSize: 32, marginBottom: 10 }}>
            Bollywood &amp; filmi
          </h1>
          <p className="page-sub" style={{ marginBottom: 16 }}>
            Bansuri, sitar, tabla and string-section filmi cues — monsoon romance, sangeet dance floors and
            sufi slow burns. Every song is an <em>original SongHub arrangement</em> with Hindi and Devanagari
            titles, so you can play it at any rung from 32 kbps MP3 up to a 24-bit WAV master, and export it
            as an MP4 video song up to 8K.
          </p>
          <div className="inline">
            <button className="btn primary" onClick={playAll} disabled={!filtered.length}>
              ▶ Play {scene === "all" ? "the shelf" : SCENES.find((s) => s.id === scene)?.label}
            </button>
            <button className="btn" onClick={() => player.setQueueOpen(true)}>
              ☰ Queue
            </button>
            <span className="dim" style={{ fontSize: 12.5 }}>
              {filtered.length} songs · downloads at {quality.label}
            </span>
          </div>
        </div>
        <Cover
          palette={tracks[0]?.palette ?? ["#ff8a3d", "#4a1079"]}
          glyph="❁"
          style={{ width: "100%", aspectRatio: "1", borderRadius: 18 }}
        />
      </section>

      <section className="card" style={{ marginBottom: 22 }}>
        <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="field-label" style={{ marginBottom: 4 }}>
              Playback &amp; download quality
            </div>
            <div className="inline">
              <QualitySelect />
              {QUICK_RUNGS.map((id) => {
                const rung = qualityOr(id);
                const isActive = player.quality === id;
                return (
                  <button
                    key={id}
                    className={`pill ${isActive ? "active" : ""}`}
                    onClick={() => player.setQuality(id)}
                    title={rung.note}
                  >
                    {rung.short}
                    {rung.dataSaver ? " · low data" : ""}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="dim" style={{ fontSize: 12, maxWidth: 320, lineHeight: 1.5 }}>
            A 3-minute song is about{" "}
            <strong>{formatBytes(estimateBytes(180, quality))}</strong> at {quality.short}. Use the ⤓ button in
            the player bar for WAV masters and MP4 video at 240p → 8K.
          </div>
        </div>
      </section>

      <div className="pill-row" style={{ marginBottom: 18 }}>
        {SCENES.map((entry) => (
          <button
            key={entry.id}
            className={`pill ${scene === entry.id ? "active" : ""}`}
            onClick={() => setScene(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loading ? (
        <EmptyState>
          <span className="spinner" /> Loading the filmi shelf…
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>No songs in this scene yet — try “Everything”.</EmptyState>
      ) : (
        <>
          {(scene === "all" ? shelves : []).map((shelf) => (
            <section className="section" key={shelf.id}>
              <div className="section-head">
                <h2 className="section-title" style={{ color: shelf.accent }}>
                  {shelf.title}
                </h2>
                <span className="section-hint">{shelf.subtitle}</span>
              </div>
              <div className="row-list">
                {shelf.tracks.map((track, index) => (
                  <BollywoodRow key={`${shelf.id}-${track.id}`} track={track} index={index} queue={shelf.tracks} />
                ))}
              </div>
            </section>
          ))}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">All songs · {SCENES.find((s) => s.id === scene)?.label}</h2>
              <span className="section-hint">{filtered.length} tracks</span>
            </div>
            <div className="row-list">
              {filtered.map((track, index) => (
                <BollywoodRow key={track.id} track={track} index={index} queue={filtered} />
              ))}
            </div>
          </section>
        </>
      )}

      <p className="dim" style={{ fontSize: 12, lineHeight: 1.6 }}>
        Honest note: these are original instrumental filmi arrangements, not the film recordings. SongHub has no
        rights to real Bollywood masters and never rips them — the film-style audio you hear is generated from a
        musical spec on our own server, which is exactly why all the quality rungs exist.
      </p>
    </div>
  );
}

function BollywoodRow({ track, index, queue }: { track: Track; index: number; queue: Track[] }) {
  const player = usePlayer();
  const isCurrent = player.current?.id === track.id;
  const quality = qualityOr(player.quality);
  const downloadHref = `/api/download/${track.id}?q=${quality.id}`;

  return (
    <div className={`track-row ${isCurrent ? "active" : ""}`} style={{ gridTemplateColumns: "26px 46px minmax(0,1fr) auto auto" }}>
      <span className="row-index">{isCurrent && player.playing ? "▶" : index + 1}</span>
      <button
        style={{ border: "none", background: "none", padding: 0 }}
        onClick={() => (isCurrent ? player.toggle() : player.playTrack(track, queue, "home"))}
        aria-label={`Play ${track.title}`}
      >
        <Cover palette={track.palette} className="row-art" style={{ width: 42, height: 42 }} glyph="❁" />
      </button>
      <div className="row-main">
        <div className="row-title">
          {track.title}
          {track.nativeTitle ? <span className="native-title"> · {track.nativeTitle}</span> : null}
        </div>
        <div className="row-sub">
          {track.artist} · {track.album} · {track.bpm} BPM · {track.moods.join(", ")}
        </div>
      </div>
      <a
        className="btn small ghost"
        href={downloadHref}
        download
        title={`Download ${quality.label} · ~${formatBytes(estimateBytes(track.duration, quality))}`}
      >
        ⤓ {quality.short}
      </a>
      <span className="row-duration">{formatTime(track.duration)}</span>
    </div>
  );
}
