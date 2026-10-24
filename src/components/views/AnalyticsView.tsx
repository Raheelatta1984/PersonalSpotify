"use client";

import { useEffect, useState } from "react";
import type { AnalyticsSummary, Track } from "@/lib/types";
import { EmptyState, Stat, TrackRow } from "../ui";

interface AnalyticsResponse {
  summary: AnalyticsSummary;
  taste: { genres: string[]; moods: string[]; artistIds: string[] };
}

export function AnalyticsView() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);

  useEffect(() => {
    fetch("/api/analytics")
      .then((res) => res.json())
      .then((payload: AnalyticsResponse) => setData(payload))
      .catch(() => undefined);
  }, []);

  if (!data) return <EmptyState><span className="spinner" /> Crunching your listening history…</EmptyState>;
  const s = data.summary;
  const maxHour = Math.max(1, ...s.byHour.map((h) => h.plays));
  const maxDay = Math.max(1, ...s.byDay.map((d) => d.plays));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Listening analytics</h1>
          <p className="page-sub">
            Every play is recorded server-side. This is the same event stream a production system would push to Kafka
            for recommendations and dashboards.
          </p>
        </div>
        <span className="badge accent">{s.streakDays}-day streak</span>
      </div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <Stat value={s.totalPlays} label="Total plays" />
        <Stat value={`${s.minutesListened}m`} label="Minutes listened" />
        <Stat value={s.uniqueTracks} label="Unique tracks" />
        <Stat value={s.topArtists[0]?.artist ?? "—"} label="Top artist" />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="section-head">
            <h2 className="section-title">Plays by hour</h2>
            <span className="section-hint">local time</span>
          </div>
          <div className="bar-chart">
            {s.byHour.map((hour) => (
              <div
                key={hour.hour}
                className={`bar ${hour.plays === 0 ? "dim" : ""}`}
                style={{ height: `${Math.max(2, (hour.plays / maxHour) * 100)}%` }}
                title={`${hour.hour}:00 — ${hour.plays} plays`}
              />
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 6, display: "flex", justifyContent: "space-between" }}>
            <span>00:00</span>
            <span>12:00</span>
            <span>23:00</span>
          </div>
        </div>

        <div className="card">
          <div className="section-head">
            <h2 className="section-title">Plays by weekday</h2>
          </div>
          <div className="bar-chart">
            {s.byDay.map((day) => (
              <div key={day.day} className={`bar ${day.plays === 0 ? "dim" : ""}`} style={{ height: `${Math.max(2, (day.plays / maxDay) * 100)}%` }} title={`${day.day}: ${day.plays}`} />
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 6, display: "flex", justifyContent: "space-between" }}>
            {s.byDay.map((d) => (
              <span key={d.day}>{d.day}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2 className="section-title" style={{ marginBottom: 12 }}>Top genres</h2>
          {s.topGenres.length ? (
            <ul className="list-plain">
              {s.topGenres.map((g) => (
                <li key={g.genre}>
                  <span>{g.genre}</span>
                  <span className="dim">{g.plays}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No data yet</EmptyState>
          )}
        </div>
        <div className="card">
          <h2 className="section-title" style={{ marginBottom: 12 }}>Top moods</h2>
          {s.topMoods.length ? (
            <ul className="list-plain">
              {s.topMoods.map((m) => (
                <li key={m.mood}>
                  <span>{m.mood}</span>
                  <span className="dim">{m.plays}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No data yet</EmptyState>
          )}
        </div>
      </div>

      <section className="section" style={{ marginTop: 24 }}>
        <div className="section-head">
          <h2 className="section-title">Most played</h2>
          <span className="section-hint">taste profile: {[...data.taste.genres, ...data.taste.moods].join(" · ") || "learning"}</span>
        </div>
        {s.topTracks.length ? (
          <div className="row-list">
            {s.topTracks.map((entry, index) => (
              <TrackRow
                key={entry.track.id}
                track={entry.track as Track}
                index={index}
                queue={s.topTracks.map((t) => t.track)}
                source="library"
                right={`${entry.plays}×`}
              />
            ))}
          </div>
        ) : (
          <EmptyState>Play a few tracks and the ranking will appear here.</EmptyState>
        )}
      </section>
    </div>
  );
}
