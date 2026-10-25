"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  QUALITIES,
  TIER_LABELS,
  VIDEO_QUALITIES,
  estimateBytes,
  estimateVideoBytes,
  formatBytes,
  qualityOr,
  videoQualityOr,
  type AudioQuality,
  type VideoTier,
} from "@/lib/audio/quality";
import { streamSrcFor, usePlayer } from "./PlayerProvider";
import { trackIndex } from "./ui";
import { exportMp4, mp4Support, saveBlob } from "@/lib/client/mp4-export";
import type { Track } from "@/lib/types";

/** Compact rung picker for the player bar. */
export function QualitySelect() {
  const player = usePlayer();
  const active = qualityOr(player.quality);
  return (
    <label className="quality-select" title="Playback quality — every rung is a fresh render of the song">
      <span className="quality-select-icon" aria-hidden>
        ▤
      </span>
      <select
        aria-label="Playback quality"
        value={active.id}
        onChange={(event) => player.setQuality(event.target.value)}
      >
        <optgroup label="MP3 — small files">
          {QUALITIES.filter((q) => q.family === "mp3").map((q) => (
            <option key={q.id} value={q.id}>
              {q.short}
              {q.dataSaver ? " · data saver" : ""}
            </option>
          ))}
        </optgroup>
        <optgroup label="WAV — uncompressed">
          {QUALITIES.filter((q) => q.family === "wav").map((q) => (
            <option key={q.id} value={q.id}>
              {q.short}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

const LENGTHS = [
  { id: "full", label: "Full song", seconds: 0 },
  { id: "60", label: "First 60 s", seconds: 60 },
  { id: "30", label: "First 30 s", seconds: 30 },
  { id: "15", label: "First 15 s", seconds: 15 },
] as const;

/**
 * Downloads + quality studio.
 *
 * Audio rungs are rendered server-side and arrive as normal file downloads.
 * MP4s are encoded on-device with WebCodecs, so the resolution ladder (240p →
 * 8K) costs the user's CPU rather than the server's.
 */
export function QualityPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = usePlayer();
  const activeQuality = qualityOr(player.quality);
  const [videoTier, setVideoTier] = useState<VideoTier>("720p");
  const [lengthId, setLengthId] = useState<(typeof LENGTHS)[number]["id"]>("full");
  const [audioKbps, setAudioKbps] = useState(128);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ ratio: number; detail?: string } | null>(null);
  const [support, setSupport] = useState<{ supported: boolean; reason?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const current = player.current;
  const track: Track | undefined = current?.id ? trackIndex.get(current.id) : undefined;
  const isCatalogTrack = Boolean(track && !track.web);
  const video = videoQualityOr(videoTier);
  const length = LENGTHS.find((entry) => entry.id === lengthId) ?? LENGTHS[0];
  const seconds = length.seconds > 0 ? Math.min(length.seconds, track?.duration ?? length.seconds) : (track?.duration ?? 180);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void mp4Support(video).then((result) => {
      if (alive) setSupport(result);
    });
    return () => {
      alive = false;
    };
  }, [open, video]);

  // Heavy rungs (4K/8K) default to a short clip so the export stays usable.
  useEffect(() => {
    if (video.heavy) setLengthId("30");
    else setLengthId("full");
  }, [video.heavy]);

  const audioRows = useMemo(
    () =>
      QUALITIES.map((quality) => ({
        quality,
        bytes: estimateBytes(seconds, quality),
        saved: quality.family === "mp3" ? Math.max(0, 100 - Math.round((quality.bytesPerSecond / 40000) * 100)) : 0,
      })),
    [seconds],
  );

  if (!open) return null;

  const fileNameBase = track
    ? `${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim()
    : "songhub";

  async function createVideo() {
    if (!track) return;
    setBusy(true);
    setProgress({ ratio: 0, detail: "Checking encoder support…" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const blob = await exportMp4({
        audioUrl: streamSrcFor(track.id, player.quality),
        track: {
          title: track.title,
          nativeTitle: track.nativeTitle,
          artist: track.artist,
          album: track.album,
          palette: track.palette,
          bpm: track.bpm,
          energy: track.energy,
          durationSec: length.seconds > 0 ? seconds : track.duration,
          badge: `SongHub · ${video.label} · ${activeQuality.short}`,
        },
        video,
        audioKbps,
        seconds: length.seconds > 0 ? seconds : undefined,
        onProgress: (p) => setProgress({ ratio: p.ratio, detail: p.detail }),
        signal: controller.signal,
      });
      saveBlob(blob, `${fileNameBase} - ${videoTier}.mp4`);
      player.toast(`MP4 ready · ${video.label} · ${formatBytes(blob.size)}`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      player.toast(`MP4 export failed: ${message}`, "err");
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="quality-panel" role="dialog" aria-label="Quality and downloads">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div>
          <strong style={{ fontSize: 14 }}>Quality &amp; downloads</strong>
          <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>
            {track ? (
              <>
                {track.title}
                {track.nativeTitle ? ` · ${track.nativeTitle}` : ""} · {track.artist} · {formatDuration(track.duration)}
              </>
            ) : (
              "Start a song to see exact file sizes for it."
            )}
          </div>
        </div>
        <button className="btn small ghost" onClick={onClose} aria-label="Close quality panel">
          ✕
        </button>
      </div>

      {track && !isCatalogTrack ? (
        <div className="answer" style={{ marginBottom: 14 }}>
          <div className="answer-icon">⇗</div>
          <p className="answer-text">
            This is a web import, so it plays at whatever quality its publisher encoded — SongHub does not
            re-encode other people&apos;s audio. Use the download button to keep the original file.
          </p>
        </div>
      ) : null}

      <div className="field-label">Audio · pick a rung for playback or download</div>
      <div className="quality-list">
        {audioRows.map(({ quality, bytes, saved }) => {
          const isActive = quality.id === activeQuality.id;
          return (
            <div key={quality.id} className={`quality-row ${isActive ? "active" : ""}`}>
              <div className="quality-main">
                <div className="quality-title">
                  {quality.label}
                  {quality.dataSaver ? <span className="badge accent">data saver</span> : null}
                  {isActive ? <span className="badge">playing</span> : null}
                </div>
                <div className="quality-sub">
                  {TIER_LABELS[quality.tier]} · {formatBytes(bytes)}
                  {quality.family === "mp3" && quality.id !== "mp3-320" ? ` · saves ~${saved}% vs 320 kbps` : ""}
                </div>
                <div className="quality-note">{quality.note}</div>
              </div>
              <div className="quality-actions">
                <button
                  className="btn small"
                  onClick={() => player.setQuality(quality.id)}
                  disabled={isActive}
                  title="Use this quality for playback"
                >
                  {isActive ? "In use" : "Use"}
                </button>
                {track ? (
                  isCatalogTrack ? (
                    <a
                      className="btn small primary"
                      href={`/api/download/${track.id}?q=${quality.id}`}
                      download
                      title={`Download ${formatBytes(bytes)} ${quality.family.toUpperCase()}`}
                    >
                      ⤓ {quality.family.toUpperCase()}
                    </a>
                  ) : (
                    <a className="btn small primary" href={`/api/download/${track.id}`} download>
                      ⤓ original
                    </a>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="field-label" style={{ marginTop: 18 }}>
        Video song · MP4 (H.264 + AAC, encoded on this device)
      </div>
      {support && !support.supported ? (
        <div className="answer" style={{ borderColor: "rgba(255,176,32,0.3)" }}>
          <div className="answer-icon">!</div>
          <p className="answer-text">
            {support.reason} You can still download MP3 or WAV — those are rendered on the server.
          </p>
        </div>
      ) : (
        <div className="quality-video">
          <label className="quality-field">
            <span>Resolution</span>
            <select value={videoTier} onChange={(event) => setVideoTier(event.target.value as VideoTier)}>
              {VIDEO_QUALITIES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="quality-field">
            <span>Length</span>
            <select value={lengthId} onChange={(event) => setLengthId(event.target.value as typeof lengthId)}>
              {LENGTHS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="quality-field">
            <span>AAC audio</span>
            <select value={audioKbps} onChange={(event) => setAudioKbps(Number(event.target.value))}>
              {[64, 96, 128, 192, 256].map((kbps) => (
                <option key={kbps} value={kbps}>
                  {kbps} kbps
                </option>
              ))}
            </select>
          </label>
          <div className="quality-video-meta">
            <span>
              {video.width}×{video.height} · {video.fps} fps · ≈{formatBytes(estimateVideoBytes(seconds, video, audioKbps))}
            </span>
            <span className="dim">{video.note}</span>
          </div>
          <div className="inline">
            <button className="btn primary small" onClick={createVideo} disabled={!track || busy}>
              {busy ? "Encoding…" : `⤓ Create ${videoTier.toUpperCase()} MP4`}
            </button>
            {busy ? (
              <button className="btn small ghost" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            ) : null}
            {!track ? <span className="dim" style={{ fontSize: 12 }}>Play a SongHub track first.</span> : null}
          </div>
          {progress ? (
            <div className="quality-progress">
              <div className="quality-progress-bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
              <span>
                {Math.round(progress.ratio * 100)}% · {progress.detail ?? "working"}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Small helper used by views that want the download URL for a rung. */
export function downloadUrlFor(trackId: string, quality: AudioQuality): string {
  return `/api/download/${trackId}?q=${quality.id}`;
}
