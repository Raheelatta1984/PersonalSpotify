"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IdentifyResult } from "@/lib/types";
import { usePlayer } from "../PlayerProvider";
import { Cover, EmptyState, SignalBars, formatTime } from "../ui";
import { decodeToPcm, pcmToBody, startMicSession, type MicSession } from "@/lib/client/audio-decode";
import { OnlinePanel } from "../OnlinePanel";

type Phase = "idle" | "listening" | "analysing" | "done";

export function IdentifyView() {
  const player = usePlayer();
  const [phase, setPhase] = useState<Phase>("idle");
  const [secondss, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(28).fill(0.05));
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexState, setIndexState] = useState<{ status: string; progress: number; trackCount: number; totalHashes: number } | null>(null);
  const [showOnline, setShowOnline] = useState(false);
  const [onlineQuery, setOnlineQuery] = useState("");
  const sessionRef = useRef<MicSession | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const res = await fetch("/api/identify/status");
      const data = (await res.json()) as { status: string; progress: number; trackCount: number; totalHashes: number };
      if (alive) setIndexState(data);
      if (alive && data.status !== "ready") setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, []);

  const stopListening = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    setPhase("analysing");
    try {
      const blob = await session.stop();
      const clip = await decodeToPcm(blob);
      await sendClip(clip.pcm, clip.sampleRate, clip.durationSec);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not process the recording");
      setPhase("idle");
    }
  }, []);

  const sendClip = useCallback(
    async (pcm: Int16Array, sampleRate: number, durationSec: number) => {
      if (durationSec < 1.2) {
        setError(`Only captured ${durationSec.toFixed(1)}s — hold the mic a little longer.`);
        setPhase("idle");
        return;
      }
      setPhase("analysing");
      setError(null);
      try {
        const res = await fetch("/api/identify", {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-sample-rate": String(sampleRate) },
          body: pcmToBody(pcm),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Identification failed (${res.status})`);
        const data = (await res.json()) as IdentifyResult;
        setResult(data);
        setPhase("done");
        if (data.best) {
          setOnlineQuery(`${data.best.track.title} ${data.best.track.artist}`);
          player.toast(`Recognised: ${data.best.track.title} — ${data.best.track.artist}`, "ok");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Identification failed");
        setPhase("idle");
      }
    },
    [player],
  );

  async function startListening() {
    setError(null);
    setResult(null);
    try {
      const session = await startMicSession();
      sessionRef.current = session;
      setPhase("listening");
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      const tick = () => {
        const level = session.getLevel();
        setLevels((prev) => [...prev.slice(1), Math.max(0.04, level)]);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      // auto-stop after 9 seconds, like Shazam
      setTimeout(() => {
        if (sessionRef.current === session) void stopListening();
      }, 9000);
    } catch (err) {
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone permission was denied. You can still upload an audio file below."
          : "Could not access the microphone. Upload an audio file instead.",
      );
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setPhase("analysing");
    try {
      const clip = await decodeToPcm(file);
      await sendClip(clip.pcm, clip.sampleRate, clip.durationSec);
    } catch {
      setError("That file could not be decoded. Try WAV, MP3, M4A or OGG.");
      setPhase("idle");
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">◎ Listen &amp; identify</h1>
          <p className="page-sub">
            Hold your phone (or laptop) near the music and SongHub fingerprints it, matches it against the library in
            milliseconds, and then offers to find it online and cache it for temporary playback.
          </p>
        </div>
        <div className="card" style={{ padding: "10px 14px", minWidth: 210 }}>
          <div className="dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            fingerprint index
          </div>
          <div className="inline" style={{ marginTop: 4 }}>
            <span className={`badge ${indexState?.status === "ready" ? "accent" : "warn"}`}>{indexState?.status ?? "…"}</span>
            <span className="dim" style={{ fontSize: 11.5 }}>
              {indexState?.status === "ready"
                ? `${indexState.trackCount} tracks · ${indexState.totalHashes?.toLocaleString()} hashes`
                : `${Math.round((indexState?.progress ?? 0) * 100)}%`}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="card stack" style={{ alignItems: "center", gap: 16, padding: 28 }}>
          <button
            className={`mic-ring ${phase === "listening" ? "listening" : ""}`}
            onClick={() => (phase === "listening" ? void stopListening() : void startListening())}
            disabled={phase === "analysing"}
            aria-label={phase === "listening" ? "Stop listening" : "Start listening"}
          >
            {phase === "analysing" ? <span className="spinner" /> : "🎙"}
          </button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 650 }}>
              {phase === "listening" ? `Listening… ${secondss}s` : phase === "analysing" ? "Analysing fingerprint…" : "Tap to listen"}
            </div>
            <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
              {phase === "listening" ? "Recording up to 9 seconds" : "Records 9s, decodes in the browser, matches on the server"}
            </div>
          </div>
          <div className="level-meter" aria-hidden>
            {levels.map((level, i) => (
              <span key={i} style={{ height: Math.max(3, level * 40) }} />
            ))}
          </div>
          <div className="inline">
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              ⤒ Upload a clip
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = "";
              }}
            />
            <button
              className="btn small ghost"
              onClick={() => {
                setResult(null);
                setError(null);
                setPhase("idle");
              }}
            >
              Reset
            </button>
          </div>
          {error ? <div className="notice danger" style={{ width: "100%" }}>{error}</div> : null}
        </div>

        <div className="stack">
          {result ? (
            <div className="card">
              <div className="inline" style={{ marginBottom: 10 }}>
                <span className={`badge ${result.ok ? "accent" : "warn"}`}>{result.ok ? "matched" : "no confident match"}</span>
                <span className="dim" style={{ fontSize: 11.5 }}>
                  confidence {(result.confidence * 100).toFixed(0)}% · {result.tookMs} ms
                </span>
              </div>
              <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.55 }}>{result.message}</p>

              <div className="row-list">
                {result.candidates.map((candidate, i) => (
                  <div className={`track-row ${i === 0 && result.ok ? "active" : ""}`} key={candidate.track.id}>
                    <span className="row-index">{i + 1}</span>
                    <button
                      style={{ border: "none", background: "none", padding: 0 }}
                      onClick={() => player.playTrack(candidate.track, result.candidates.map((c) => c.track), "identify")}
                      aria-label={`Play ${candidate.track.title}`}
                    >
                      <Cover palette={candidate.track.palette} className="row-art" style={{ width: 44, height: 44 }} />
                    </button>
                    <div className="row-main">
                      <div className="row-title">{candidate.track.title}</div>
                      <div className="row-sub">
                        {candidate.track.artist} · offset {formatTime(candidate.offsetSec)} · {candidate.matchedHashes} hash votes
                      </div>
                    </div>
                    <SignalBars value={candidate.score} />
                    <span className="row-duration">{formatTime(candidate.track.duration)}</span>
                  </div>
                ))}
              </div>

              <div className="card" style={{ marginTop: 14, background: "rgba(255,255,255,0.03)" }}>
                <div className="dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  signal analysis
                </div>
                <div className="inline" style={{ gap: 10, fontSize: 12 }}>
                  <span className="badge">{result.input.durationSec}s clip</span>
                  <span className="badge">{result.input.rms.toFixed(3)} rms</span>
                  <span className="badge">peak {result.input.peakAmplitude.toFixed(2)}</span>
                  <span className="badge">~{result.input.tempoBpm} bpm</span>
                  <span className="badge">~{result.input.dominantPitchHz} Hz</span>
                </div>
              </div>

              <div className="inline" style={{ marginTop: 14 }}>
                {result.best ? (
                  <button className="btn primary small" onClick={() => player.playTrack(result.best!.track, result.candidates.map((c) => c.track), "identify")}>
                    ▶ Play the match
                  </button>
                ) : null}
                <button
                  className="btn small"
                  onClick={() => {
                    setShowOnline(true);
                    setOnlineQuery((prev) => prev || (result.best ? `${result.best.track.title} ${result.best.track.artist}` : ""));
                  }}
                >
                  ⇗ Find it online
                </button>
              </div>
            </div>
          ) : phase === "idle" ? (
            <EmptyState>
              Nothing identified yet. Tap the mic, play a SongHub track nearby, or upload a clip — the recogniser works
              on noisy, phone-quality audio.
            </EmptyState>
          ) : null}
        </div>
      </div>

      {showOnline ? (
        <section className="section" style={{ marginTop: 26 }}>
          <div className="section-head">
            <h2 className="section-title">Find it online → cache → play</h2>
            <span className="section-hint">searches public catalogues and downloads a temporary copy</span>
          </div>
          <OnlinePanel initialQuery={onlineQuery} autoRun />
        </section>
      ) : null}
    </div>
  );
}
