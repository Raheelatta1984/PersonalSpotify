"use client";

import { useMemo, useState } from "react";
import type { SearchResult } from "@/lib/types";
import { usePlayer } from "../PlayerProvider";
import { EmptyState, SignalBars, TrackRow, formatTime } from "../ui";

const EXAMPLES = [
  "warm lo-fi for a rainy drive, nothing with vocals, not too fast",
  "music to help me focus while coding",
  "sounds like Tycho",
  "make me a playlist of upbeat summer pop",
  "sad acoustic folk guitar for a winter evening",
  "dark industrial club banger at 128 bpm",
  "jazz piano from the 2010s",
  "neon overpas",
];

export function SearchView() {
  const player = usePlayer();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const queue = useMemo(() => result?.hits.map((h) => h.track) ?? [], [result]);

  async function run(nextQuery?: string) {
    const q = (nextQuery ?? query).trim();
    if (!q) return;
    setQuery(q);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, limit: 12 }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      setResult((await res.json()) as SearchResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  async function saveAsPlaylist() {
    if (!result) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ai/playlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: result.query, size: result.hits.length }),
      });
      const data = (await res.json()) as { savedPlaylist?: { name: string } };
      player.toast(data.savedPlaylist ? `Saved playlist “${data.savedPlaylist.name}”` : "Playlist saved", "ok");
    } catch {
      player.toast("Could not save the playlist", "err");
    } finally {
      setSaving(false);
    }
  }

  const filters = result?.understanding.filters ?? {};
  const activeFilters = [
    ...(filters.genres ?? []).map((g) => `genre: ${g}`),
    ...(filters.moods ?? []).map((m) => `mood: ${m}`),
    filters.instrumental === true ? "instrumental only" : filters.instrumental === false ? "with vocals" : "",
    filters.minBpm ? `${filters.minBpm}–${filters.maxBpm} BPM` : "",
    filters.decade ? `${filters.decade}s` : "",
  ].filter(Boolean);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">✦ AI search</h1>
          <p className="page-sub">
            Ask in plain language. SongHub parses intent (mood, tempo, genre, era, vocals), searches by meaning as
            well as words, and tells you why each track matched.
          </p>
        </div>
      </div>

      <form
        className="search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          className="input"
          placeholder="e.g. something warm for a rainy drive, nothing with vocals, not too fast"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search query"
        />
        <button className="btn primary" type="submit" disabled={loading || !query.trim()}>
          {loading ? <span className="spinner" /> : "Search"}
        </button>
      </form>

      <div className="pill-row" style={{ marginTop: 12 }}>
        {EXAMPLES.map((example) => (
          <button key={example} className="pill" onClick={() => void run(example)}>
            {example}
          </button>
        ))}
      </div>

      {error ? <div className="notice danger" style={{ marginTop: 16 }}>{error}</div> : null}

      {result ? (
        <>
          <div className="answer">
            <div className="answer-icon">✦</div>
            <div>
              <p className="answer-text">{result.answer}</p>
              <ul className="answer-reasoning">
                {result.understanding.reasoning.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
                <li>
                  ranked {result.hits.length} tracks in {result.tookMs} ms
                  {result.fallbackUsed ? " (filters relaxed to avoid an empty result)" : ""}
                </li>
              </ul>
            </div>
          </div>

          {activeFilters.length ? (
            <div className="pill-row" style={{ marginBottom: 14 }}>
              {activeFilters.map((f) => (
                <span className="pill active" key={f}>
                  {f}
                </span>
              ))}
            </div>
          ) : null}

          <div className="section-head">
            <h2 className="section-title">{result.hits.length} matches</h2>
            <div className="inline">
              <button className="btn small" onClick={() => queue.length && player.playTrack(queue[0], queue, "search")}>
                ▶ Play all
              </button>
              <button className="btn small" onClick={() => void saveAsPlaylist()} disabled={saving || !queue.length}>
                {saving ? "Saving…" : "＋ Save as playlist"}
              </button>
            </div>
          </div>

          {result.hits.length ? (
            <div className="row-list">
              {result.hits.map((hit, index) => (
                <TrackRow key={hit.track.id} track={hit.track} index={index} queue={queue} source="search" reasons={hit.reasons} score={hit.score} />
              ))}
            </div>
          ) : (
            <EmptyState>No matches. Try describing a mood instead of an exact title.</EmptyState>
          )}

          <section className="section" style={{ marginTop: 26 }}>
            <div className="section-head">
              <h2 className="section-title">Why these? Signal breakdown</h2>
              <span className="section-hint">lexical · semantic · metadata · popularity · reference</span>
            </div>
            <div className="grid grid-2">
              {result.hits.slice(0, 4).map((hit) => (
                <div className="card" key={`sig-${hit.track.id}`}>
                  <div className="row-between">
                    <strong style={{ fontSize: 14 }}>{hit.track.title}</strong>
                    <SignalBars value={hit.score} />
                  </div>
                  <div className="stack" style={{ marginTop: 12, gap: 7 }}>
                    {Object.entries(hit.signals).map(([key, value]) => (
                      <div key={key} className="inline" style={{ gap: 10 }}>
                        <span className="dim" style={{ width: 78, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          {key}
                        </span>
                        <div style={{ flex: 1, height: 6, borderRadius: 999, background: "rgba(255,255,255,0.1)" }}>
                          <div
                            style={{
                              height: 6,
                              borderRadius: 999,
                              width: `${Math.min(100, value * 100)}%`,
                              background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
                            }}
                          />
                        </div>
                        <span className="dim" style={{ fontSize: 11.5, width: 34, textAlign: "right" }}>
                          {value.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <ul className="answer-reasoning" style={{ marginTop: 10 }}>
                    {hit.reasons.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                  <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>
                    {hit.track.artist} · {hit.track.year} · {hit.track.bpm} BPM · {formatTime(hit.track.duration)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : loading ? (
        <EmptyState>
          <span className="spinner" /> Understanding your request…
        </EmptyState>
      ) : (
        <EmptyState>Try an example above, or describe a mood, tempo and moment.</EmptyState>
      )}
    </div>
  );
}
