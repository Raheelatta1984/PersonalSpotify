"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowseDocument, OnlineResult, TempDownload } from "@/lib/types";
import { usePlayer } from "./PlayerProvider";

interface SearchOutcome {
  query: string;
  results: OnlineResult[];
  providers: { provider: string; ok: boolean; count: number; error?: string; tookMs: number }[];
  live: boolean;
  tookMs: number;
  notice?: string;
}

export function OnlinePanel({ initialQuery, autoRun = false }: { initialQuery?: string; autoRun?: boolean }) {
  const player = usePlayer();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [doc, setDoc] = useState<BrowseDocument | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [download, setDownload] = useState<TempDownload | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const lastAuto = useRef<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setDoc(null);
    try {
      const res = await fetch("/api/online/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, limit: 8 }),
      });
      setOutcome((await res.json()) as SearchOutcome);
    } catch {
      player.toast("Online search failed", "err");
    } finally {
      setLoading(false);
    }
  }, [player]);

  useEffect(() => {
    if (autoRun && initialQuery && initialQuery.trim() && lastAuto.current !== initialQuery) {
      lastAuto.current = initialQuery;
      setQuery(initialQuery);
      void runSearch(initialQuery);
    }
  }, [autoRun, initialQuery, runSearch]);

  async function openResult(result: OnlineResult) {
    setDocLoading(true);
    setDoc(null);
    try {
      const res = await fetch("/api/online/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultId: result.id, query: outcome?.query ?? result.title }),
      });
      setDoc((await res.json()) as BrowseDocument);
    } finally {
      setDocLoading(false);
    }
  }

  async function downloadAndPlay(result: OnlineResult) {
    setDownloading(result.id);
    try {
      const res = await fetch("/api/online/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultId: result.id, query: outcome?.query ?? result.title, ttlSeconds: 600 }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Download failed");
      const payload = (await res.json()) as TempDownload;
      setDownload(payload);
      setRemaining(payload.ttlSeconds);
      player.playNowPlaying(
        {
          id: null,
          title: payload.title,
          artist: payload.artist,
          album: `temporary download · ${payload.source}`,
          palette: ["#ffb020", "#7c2d12"],
          src: payload.streamUrl,
          tempToken: payload.token,
          expiresAt: payload.expiresAt,
          origin: "temp",
        },
        "online",
      );
      player.toast(
        `Downloaded “${payload.title}” to temp storage — it plays from the local copy and disappears in ${Math.round(payload.ttlSeconds / 60)} min.`,
        "ok",
      );
    } catch (error) {
      player.toast(error instanceof Error ? error.message : "Download failed", "err");
    } finally {
      setDownloading(null);
    }
  }

  async function discard() {
    if (!download) return;
    await fetch(`/api/temp/${download.token}`, { method: "DELETE" });
    setDownload(null);
    player.toast("Temporary download deleted.", "info");
  }

  useEffect(() => {
    if (!download) return;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.round((Date.parse(download.expiresAt) - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setDownload(null);
        player.toast("Temporary download expired and was removed from the server.", "info");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [download, player]);

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
          placeholder="Search the web for a song, artist or lyric…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="btn primary" type="submit" disabled={loading || !query.trim()}>
          {loading ? <span className="spinner" /> : "Search web"}
        </button>
      </form>

      {outcome?.notice ? <div className="notice">{outcome.notice}</div> : null}

      {outcome ? (
        <div className="inline" style={{ gap: 6 }}>
          {outcome.providers.map((p) => (
            <span key={p.provider} className={`badge ${p.ok && p.count ? "accent" : ""}`} title={p.error ?? `${p.count} results in ${p.tookMs}ms`}>
              {p.provider} {p.ok ? `· ${p.count}` : "· offline"}
            </span>
          ))}
          <span className="dim" style={{ fontSize: 11.5 }}>
            {outcome.results.length} results in {outcome.tookMs} ms
          </span>
        </div>
      ) : null}

      {download ? (
        <div className="card" style={{ borderColor: "rgba(255,176,32,0.35)", background: "rgba(255,176,32,0.07)" }}>
          <div className="row-between">
            <div>
              <div className="inline">
                <span className="badge warn">temporary</span>
                <strong style={{ fontSize: 14 }}>{download.title}</strong>
              </div>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                {download.artist} · {download.live ? "live preview copied from provider" : "generated 30s preview"} ·{" "}
                {(download.bytes / 1024).toFixed(0)} kB · {download.contentType}
              </div>
            </div>
            <div className="inline">
              <span className="ttl">⏳ {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span>
              <button className="btn small" onClick={() => void discard()}>
                Delete now
              </button>
            </div>
          </div>
          <audio controls src={download.streamUrl} style={{ width: "100%", marginTop: 12 }} />
          <div className="dim" style={{ fontSize: 11.5, marginTop: 6 }}>
            Streaming from local temp storage · expires {new Date(download.expiresAt).toLocaleTimeString()} · license: {download.license}
          </div>
        </div>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack" style={{ gap: 10 }}>
          {loading ? (
            <div className="empty">
              <span className="spinner" /> Querying catalogues…
            </div>
          ) : outcome?.results.length ? (
            outcome.results.map((result) => (
              <div className="card" key={result.id} style={{ padding: 14 }}>
                <div className="row-between">
                  <div style={{ minWidth: 0 }}>
                    <div className="row-title">{result.title}</div>
                    <div className="row-sub">
                      {result.artist}
                      {result.album ? ` · ${result.album}` : ""}
                    </div>
                  </div>
                  <span className="badge violet">{result.sourceLabel}</span>
                </div>
                <div className="inline" style={{ marginTop: 10, gap: 6 }}>
                  <span className="badge">conf {(result.confidence * 100).toFixed(0)}%</span>
                  {result.durationSec ? <span className="badge">{Math.floor(result.durationSec / 60)}:{String(result.durationSec % 60).padStart(2, "0")}</span> : null}
                  <span className="badge">{result.license}</span>
                </div>
                <div className="inline" style={{ marginTop: 12 }}>
                  <button className="btn small" onClick={() => void openResult(result)}>
                    Open in browser
                  </button>
                  <button
                    className="btn small primary"
                    onClick={() => void downloadAndPlay(result)}
                    disabled={downloading === result.id}
                  >
                    {downloading === result.id ? <span className="spinner" /> : "⤓ Download & play"}
                  </button>
                </div>
                {result.notes ? (
                  <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
                    {result.notes}
                  </div>
                ) : null}
              </div>
            ))
          ) : outcome ? (
            <div className="empty">No results — try a shorter query.</div>
          ) : (
            <div className="empty">Search the public catalogues, open a result in the built-in browser, then download it temporarily to play.</div>
          )}
        </div>

        <div className="browser-frame" style={{ position: "sticky", top: 0 }}>
          <div className="browser-chrome">
            <div className="browser-dots">
              <span /> <span /> <span />
            </div>
            <div className="browser-url">{doc?.url ?? "songhub://browser"}</div>
            {doc ? <span className={`badge ${doc.fetchedLive ? "accent" : "warn"}`}>{doc.fetchedLive ? "live" : "rendered"}</span> : null}
          </div>
          <div className="browser-body">
            {docLoading ? (
              <div className="empty">
                <span className="spinner" /> Loading page…
              </div>
            ) : doc ? (
              <>
                {doc.notice ? <div className="notice" style={{ marginBottom: 14 }}>{doc.notice}</div> : null}
                {doc.blocks.map((block, i) => {
                  if (block.type === "heading") {
                    const Tag = (`h${Math.min(3, block.level ?? 2)}`) as "h1" | "h2" | "h3";
                    return <Tag key={i}>{block.text}</Tag>;
                  }
                  if (block.type === "meta") return <p key={i} className="dim" style={{ fontSize: 12 }}>{block.text}</p>;
                  if (block.type === "image") return <img key={i} src={block.src} alt="" />;
                  if (block.type === "audio") return <audio key={i} controls src={block.src} />;
                  if (block.type === "link") {
                    const internal = block.href?.startsWith("/");
                    return (
                      <p key={i}>
                        {internal ? (
                          <a href={block.href}>{block.text}</a>
                        ) : (
                          <a href={block.href} target="_blank" rel="noreferrer noopener">
                            {block.text} ↗
                          </a>
                        )}
                      </p>
                    );
                  }
                  return <p key={i}>{block.text}</p>;
                })}
              </>
            ) : (
              <div className="empty">No page open. Pick a result to render it here.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
