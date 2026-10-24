"use client";

import type { Playlist, SearchHit, Track } from "@/lib/types";
import { usePlayer, nowPlayingFromTrack } from "./PlayerProvider";

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Cover({
  palette,
  size,
  glyph,
  className = "",
  style,
}: {
  palette: [string, string];
  size?: number;
  glyph?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`cover ${className}`}
      style={{
        background: `linear-gradient(150deg, ${palette[0]}, ${palette[1]})`,
        width: size,
        height: size,
        ...style,
      }}
      aria-hidden
    >
      <span className="cover-glyph">{glyph ?? "♪"}</span>
    </div>
  );
}

export function TrackCard({
  track,
  queue,
  source = "home",
  badge,
}: {
  track: Track;
  queue?: Track[];
  source?: string;
  badge?: string;
}) {
  const player = usePlayer();
  const isCurrent = player.current?.id === track.id;
  const isPlayingThis = isCurrent && player.playing;

  return (
    <div className={`track-card ${isCurrent ? "playing" : ""}`}>
      <div style={{ position: "relative" }}>
        <Cover palette={track.palette} glyph={track.instrumental ? "♪" : "♫"} />
        <button
          className="cover-play"
          aria-label={isPlayingThis ? `Pause ${track.title}` : `Play ${track.title}`}
          onClick={() => (isCurrent ? player.toggle() : player.playTrack(track, queue, source))}
        >
          {isPlayingThis ? "❚❚" : "▶"}
        </button>
      </div>
      <div>
        <p className="card-title">{track.title}</p>
        <p className="card-artist">{track.artist}</p>
      </div>
      <div className="card-meta">
        <span>{track.bpm} BPM</span>
        <span>·</span>
        <span>{formatTime(track.duration)}</span>
        {badge ? <span className="badge accent">{badge}</span> : null}
      </div>
    </div>
  );
}

export function TrackRow({
  track,
  index,
  queue,
  source = "home",
  reasons,
  score,
  right,
}: {
  track: Track;
  index?: number;
  queue?: Track[];
  source?: string;
  reasons?: string[];
  score?: number;
  right?: React.ReactNode;
}) {
  const player = usePlayer();
  const isCurrent = player.current?.id === track.id;
  const liked = false;

  return (
    <div className={`track-row ${isCurrent ? "active" : ""}`}>
      <span className="row-index">{isCurrent && player.playing ? "▶" : (index ?? 0) + 1}</span>
      <button
        style={{ border: "none", background: "none", padding: 0 }}
        onClick={() => (isCurrent ? player.toggle() : player.playTrack(track, queue, source))}
        aria-label={`Play ${track.title}`}
      >
        <Cover palette={track.palette} className="row-art" style={{ width: 44, height: 44 }} glyph={track.instrumental ? "♪" : "♫"} />
      </button>
      <div className="row-main">
        <div className="row-title">{track.title}</div>
        <div className="row-sub">
          {track.artist} · {track.album}
          {track.genres.length ? ` · ${track.genres.join(", ")}` : ""}
          {track.web ? ` · ${track.web.providerLabel}` : ""}
          {reasons?.length ? ` — ${reasons[0]}` : ""}
        </div>
      </div>
      {typeof score === "number" ? (
        <div className="card-meta" title="match score">
          <SignalBars value={score} />
        </div>
      ) : null}
      <div className="row-actions">
        <button className="icon-btn" title="Add to queue" onClick={() => player.enqueue(track)}>
          +
        </button>
        <button
          className="icon-btn"
          title={liked ? "Unlike" : "Like"}
          onClick={async () => {
            const res = await fetch("/api/library", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "toggle-like", trackId: track.id }),
            });
            const data = (await res.json()) as { liked?: boolean };
            player.toast(data.liked ? `Liked “${track.title}”` : `Removed “${track.title}” from liked`, "ok");
          }}
        >
          ♥
        </button>
      </div>
      <span className="row-duration">{right ?? formatTime(track.duration)}</span>
    </div>
  );
}

export function SignalBars({ value }: { value: number }) {
  const filled = Math.round(Math.min(1, value) * 5);
  return (
    <div className="signal-bars" title={`match ${(value * 100).toFixed(0)}%`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`signal-bar ${i < filled ? "on" : ""}`}
          style={{ height: 6 + i * 4 }}
        />
      ))}
    </div>
  );
}

export function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function PlaylistCard({ playlist, onOpen }: { playlist: Playlist; onOpen: () => void }) {
  const player = usePlayer();
  return (
    <div className="track-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <Cover palette={playlist.palette} glyph="≣" />
      <div>
        <p className="card-title">{playlist.name}</p>
        <p className="card-artist">
          {playlist.trackIds.length} tracks {playlist.aiGenerated ? "· AI" : ""}
        </p>
      </div>
      <button
        className="cover-play"
        style={{ opacity: 1, transform: "none" }}
        aria-label={`Play ${playlist.name}`}
        onClick={(event) => {
          event.stopPropagation();
          const tracks = playlist.trackIds
            .map((id) => trackIndex.get(id))
            .filter((t): t is Track => Boolean(t));
          if (tracks.length) player.playTrack(tracks[0], tracks, "playlist");
        }}
      >
        ▶
      </button>
    </div>
  );
}

/** Populated by App on boot so playlist cards can resolve ids to tracks. */
export const trackIndex = new Map<string, Track>();

export function SearchHitRow({ hit, queue }: { hit: SearchHit; queue: Track[] }) {
  return <TrackRow track={hit.track} queue={queue} source="search" reasons={hit.reasons} score={hit.score} />;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function CoverStack({ tracks }: { tracks: Track[] }) {
  const first = tracks[0] ?? { palette: ["#59d4b5", "#123f3a"] as [string, string] };
  return <Cover palette={first.palette} glyph="≋" />;
}

export function toNowPlaying(track: Track) {
  return nowPlayingFromTrack(track);
}
