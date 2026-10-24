# SongHub — your personal Spotify, with AI ears

A complete, self-contained music streaming platform built from the system‑design sketch in
[`Screenshot_20261025_020020_Facebook.jpg`](./Screenshot_20261025_020020_Facebook.jpg):
clients → API gateway → microservice-style modules → data stores → event stream → analytics.

Everything runs locally with **zero external services, zero audio files and zero API keys**.

```
 Spotify design sketch            SongHub implementation
 ─────────────────────            ──────────────────────
 Music streaming, low latency  →  byte-range WAV streaming synthesised on demand (seek = free)
 Search + AI recommendations   →  hybrid BM25 + semantic embeddings + intent parser
 Offline playback              →  temporary (TTL) download cache you can play and forget
 Social sharing                →  shareable playlists, AI "studio", tasting profile
 Real-time analytics           →  play-event stream → analytics dashboard
 Catalog DB / Blob storage     →  deterministic synth catalog + JSON/binary store in `.data/`
```

---

## Table of contents

1. [What it does](#what-it-does)
2. [Quick start](#quick-start)
3. [The three headline features](#the-three-headline-features)
   - [1. AI-powered song search](#1-ai-powered-song-search)
   - [2. Hear it → identify it](#2-hear-it--identify-it)
   - [3. In-app browser → temporary download → play](#3-in-app-browser--temporary-download--play)
   - [4. Web music → play → playlist](#4-web-music--play--playlist-mp3juicesc)
4. [Architecture](#architecture)
5. [How the audio works](#how-the-audio-works)
6. [API reference](#api-reference)
7. [Testing](#testing)
8. [Performance notes](#performance-notes)
9. [Trade-offs](#trade-offs)
10. [Project layout](#project-layout)

---

## What it does

| Area | What you get |
| --- | --- |
| **Library** | 24 original tracks across 12 artists, 12 genres, 10 moods — all *generated* by a synth engine, so there's no sample licensing and playback is byte-identical every time. |
| **AI search** | Type "warm lo-fi for a rainy drive, nothing with vocals, not too fast" and get ranked matches *plus* an explanation of what it understood. |
| **Listen & identify** | Hold the mic (or upload a clip) and SongHub fingerprints it Shazam-style, matches it against the library in milliseconds and reports the offset. |
| **Web + browser** | Search iTunes / Internet Archive / Jamendo, open results in an in-app browser, then download one to server temp storage and play it from that copy until the timer expires. |
| **Web music** | Scrape every song result from **mp3juice.sc** (real titles, artists, durations, song URLs), play them inside the app, and save them into playlists with the title **and** source URL attached. Misses fall through to Google/DuckDuckGo/iTunes automatically. |
| **Player** | Queue, shuffle, repeat, seek, volume, keyboard shortcuts, temp-file countdown. |
| **Personal layer** | Likes, playlists, play events, taste profile, radio, analytics (hourly/weekday charts, streaks, top artists/genres/moods). |
| **AI studio** | "Make me 40 minutes of focus music with no vocals" → a named, saved, explained playlist. |

## Quick start

```bash
npm install
npm run index:audio   # optional: pre-build the fingerprint DB (~16 s, cached in .data/)
npm run dev           # http://localhost:3000
```

Then open the app and try:

* **AI Search** → `warm lo-fi for a rainy drive, nothing with vocals, not too fast`
* **Identify** → tap the mic and play any SongHub track on another device (or upload a clip)
* **Web Music** → search "get lucky", hit **▶ Play** (it plays in the app), then **＋ Add to playlist**
* **Web & Browser** → search "neon", open a result, hit **⤓ Download & play**

Useful scripts:

```bash
npm run dev        # dev server (0.0.0.0:3000)
npm run build      # production build
npm run start      # production server
npm run typecheck  # tsc --noEmit
npm run test       # 1,601 tests across 13 suites
npm run verify     # typecheck + tests
npm run index:audio# pre-build the audio fingerprint index
```

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SONGHUB_DATA_DIR` | `./.data` | Where runtime state (playlists, events, temp downloads, fingerprint cache) lives |
| `JAMENDO_CLIENT_ID` | — | Enables the Jamendo provider; without it that source is skipped |
| `MP3JUICE_BASE_URL` | `https://mp3juice.sc` | Which mirror/clone of the site the scraper queries |
| `GOOGLE_API_KEY` | — | Google Programmable Search key; enables the Google fallback |
| `GOOGLE_CSE_ID` | — | Google Programmable Search engine id (used with `GOOGLE_API_KEY`) |

---

## The headline features

### 1. AI-powered song search

`POST /api/search` runs a 4-stage pipeline, all local and deterministic:

```
 query ──► understand ──► hybrid retrieve ──► rank ──► explain
           │              │                    │        │
     intents, filters,  BM25 (title/artist/  weighted  natural-language
     negations, seeds,  tags/lyrics-ish)  +  blend +   answer + per-hit
     energy/valence     embeddings cosine    tiers    reasons + signals
```

**Understanding** (`src/lib/ai/understand.ts`) extracts:

* **genre / mood** from a 30-concept lexicon (`focus`, `chill`, `rain`, `gym`, …)
* **negation** — "nothing with vocals", "no rap", "not too fast" → hard exclusions
* **tempo** — "128 bpm", "slow", "fast"; "not too fast" caps the range instead
* **era** — "90s", "2023", "the 2010s"
* **references** — "sounds like Tycho", exact/typo'd titles, artist names
* **instructions** — play / shuffle / queue / make a playlist / "top 5"

**Retrieval** (`src/lib/ai/index.ts`, `src/lib/ai/embed.ts`) combines:

* classic **BM25** over a field-weighted inverted index (title ×4, artist ×3, tags ×1.8, …)
* **fuzzy rescue**: a term that misses the index is compared against the doc's own
  vocabulary with edit-distance + trigram Dice, so `neon overpas` and `lofy beatz` still work
* **semantic embeddings**: 512-dimension hashed feature vectors (unigrams, bigrams,
  char-trigrams, structured metadata, concept clusters), L2-normalised, cosine-scored —
  a dependency-free stand-in for a trained embedding model that generalises
  "help me concentrate while coding" → lo-fi *and* ambient *and* minimal techno

**Ranking** blends lexical, semantic, metadata fit, popularity, reference similarity and your
taste profile, with **progressive filter relaxation**: if strict filters starve the result set
the ranker sheds the weakest constraint, marks the fillers `relaxed`, and tops the page up.

**Explanation** — every hit carries per-signal sub-scores and human reasons
(`Closely related to "Saltwater Radio" (88% similarity)`), and the response includes a generated
sentence: *"Here are 6 lo-fi tracks with a calm feel. Start with 'Rain on the Tram' …"*.

### 2. Hear it → identify it

```
 mic / upload ─► decode (Web Audio) ─► 8 kHz mono PCM ─► POST /api/identify
                                                          │
    ┌─────────────────────────────────────────────────────┘
    ▼
 STFT (1024, 25 ms hop) ─► constellation peaks ─► (f₁,f₂,Δt) hashes ─► offset histogram
                                                                        │
                        ranked candidates + confidence + offset ◄───────┘
```

* **Fingerprinting** (`src/lib/audio/fingerprint.ts`): radix-2 FFT → log-magnitude spectrogram →
  neighbourhood-peak picking → paired hashes with a 2 s forward window. Robust to gain changes,
  clipping and room noise, invariant to *where* in the song the pair occurs.
* **Matching**: every hash hit votes for `dbTime − queryTime`; the correct track produces a sharp
  peak at the true offset. Confidence is a saturating function of votes and margin
  (`confidenceFromVotes`), and the endpoint refuses to claim a match below 0.42.
* **Benchmarks** (in the test suite): 24/24 tracks identified from noisy 6 s excerpts, offsets
  within ~2 s, graceful degradation down to ~0 dB SNR (true track still in the shortlist).
* **Browser side** (`src/lib/client/audio-decode.ts`): MediaRecorder → `decodeAudioData` →
  `OfflineAudioContext` resample to 8 kHz mono → Int16Array upload. No ffmpeg, no server codec.

### 3. In-app browser → temporary download → play

```
 /api/online/search ─► results (iTunes preview · Internet Archive · Jamendo · demo fallback)
        │
        ├─► /api/online/browse ─► HTML → typed blocks → rendered "browser" panel (audio, links, images)
        │
        └─► /api/online/download ─► fetch preview (or generate a 30 s preview)
                                     └─► .data/downloads/<token>.wav  + registry entry with expiry
                                              └─► /api/temp/<token> (Range-enabled streaming)
                                                        └─► countdown UI → auto-delete + sweeper
```

* TTL is 10 minutes by default, clamped to 30 s – 30 min, enforced in three places: the
  `GET /api/temp/<token>` handler (410 Gone when expired), an opportunistic sweeper on every
  download/list request, and the browser countdown.
* Live provider audio is only used when the provider itself offers a legal preview
  (iTunes 30 s previews); otherwise SongHub generates a short preview from the catalog track and
  labels it as such. Nothing is written outside `SONGHUB_DATA_DIR`.
* The in-app browser is a real server-side extractor (`htmlToDocument`), not an iframe, so it
  works in sandboxed environments and never executes remote scripts.

---

### 4. Web music → play → playlist (mp3juice.sc)

```
 query ──► scrape mp3juice.sc ──► rows? ──► yes ─┐
                                   │ no          │
                                   ▼             │
                    Google CSE ─► DuckDuckGo ─► iTunes metadata
                                   │             │
                                   └──── hits ───┘
                                                 ▼
   ▶ Play  ──► /api/web/play ──► resolve lawful audio ──► save web_… + /api/stream/web_…
   ＋ List ──► /api/playlists/:id/tracks { hit } ──► playlist keeps title + song URL
```

* **Scraping** (`src/lib/online/mp3juice.ts`) is multi-strategy on purpose — the site's clones
  differ. Data-attribute rows (`data-songtitle`/`data-artist`/`data-duration`), embedded
  Next.js/Nuxt JSON, table layouts and loose `/download` anchors are all parsed, then merged,
  de-duplicated and ranked. Every row keeps the **song page URL** it was found on.
* **Fallback** (`src/lib/online/web.ts`): if mp3juice.sc returns fewer than three rows the
  search automatically continues on Google (when `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` are set),
  then DuckDuckGo, then the iTunes catalogue — labelled per row so you know where it came from.
  Air-gapped runs fall back to the offline demo catalogue with a visible notice.
* **Playback** (`src/lib/online/resolve.ts`) only ever uses audio the rights-holder publishes:
  Apple's licensed 30-second previews, Internet Archive items that declare a licence, Jamendo
  (CC), or a self-hosted/archive file. When no lawful recording exists SongHub synthesises a
  deterministic 30-second preview of its own and says so. No stream-ripping, no YouTube
  extraction, no DRM bypass.
* **Saving** (`src/lib/online/weblibrary.ts`): playing or adding a web result persists a
  `WebTrack` — real title, artist, album, duration, artwork, **source URL**, resolved audio URL,
  licence and playback kind — in `.data/web-tracks.json`. Playlists store the `web_…` id, and
  the same id renders, queues and streams like a catalog track, so the entry survives restarts
  with its title and URL intact.
* **Streaming** (`src/lib/online/webstream.ts`): `/api/stream/web_…` downloads the lawful audio
  once into `.data/web-audio/`, serves it with `Range` support (seeking works), and falls back to
  the synth preview if the source disappears. Headers `X-Playback-Kind` / `X-Audio-Cached` tell
  the UI exactly what is playing.
* **UI** adds a **Web Music** view: search, ▶ Play, ＋ Add to playlist (existing or new), open the
  original page, and a "Saved from the web" list. Playlists and the Library show the stored
  source URL next to every web import.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  clients (React 19 / Next 16 app router)                                      │
│  Home · AI Search · Identify · Web+Browser · Library · Analytics · PlayerBar   │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ fetch (JSON + binary PCM)
┌───────────────────────────────▼───────────────────────────────────────────────┐
│  "API gateway" = Next route handlers (rate-limit-friendly, CORS headers)      │
│  /api/search  /api/identify  /api/stream  /api/online/*  /api/temp/*  …       │
└───┬────────────┬──────────────┬───────────────┬──────────────┬────────────────┘
    │            │              │               │              │
┌───▼──────┐ ┌───▼────────┐ ┌───▼──────────┐ ┌──▼──────────┐ ┌▼──────────────┐
│ catalog  │ │ AI service │ │ audio service│ │ online svc  │ │ personal svc  │
│ tracks + │ │ understand │ │ synth (WAV)  │ │ providers   │ │ likes, lists, │
│ artists  │ │ index BM25 │ │ fingerprint  │ │ browser     │ │ events, taste │
│ 24/12    │ │ embeddings │ │ identify     │ │ temp cache  │ │ analytics     │
└───┬──────┘ └───┬────────┘ └───┬──────────┘ └──┬──────────┘ └┬──────────────┘
    │            │              │               │             │
┌───▼────────────▼──────────────▼───────────────▼─────────────▼───────────────┐
│  data stores (`.data/`, gitignored)                                          │
│  playlists.json · library.json · events.json · downloads/<token> ·           │
│  cache/fingerprint-index.{meta.json,bin}                                     │
└─────────────────────────────────────────────────────────────────────────────┘
        play events ──► analytics + taste profile ──► recommendations/radio
```

*In production this maps 1:1 onto the sketch: swap the JSON store for
Postgres + Redis + S3, the in-process event array for Kafka, and the route handlers for
containerised services behind an API gateway.*

## How the audio works

There are **no audio files in this repository**. Each track is a `TrackSpec`:

```ts
{ root, scale, progression, bpm, bars, swing, gain, seed,
  voices: { pad, bass, arp, drums, pluck, shimmer } }
```

`sampleAt(spec, t)` is a **pure function** of time — wavetable sines, per-voice ADSR envelopes,
a deterministic PRNG for noise/hi-hats, and a soft-clip master stage. Consequences:

* **Seeking is free.** Serving bytes 1 MB–1.5 MB costs the same as serving the first 500 kB, so
  `Range:` requests are exact and the player scrubs instantly (`renderWavBytes` maps byte offsets
  to sample indices, handling mid-sample alignment).
* **Reproducible fingerprints.** The same spec renders bit-identical audio on every machine, which
  makes the audio tests meaningful instead of flaky.
* **Tiny repo.** The whole "catalog" is ~1,200 lines of data + DSP.
* **No licensing questions.** Every track is original, synthesised at request time.

Rates: 22.05 kHz for playback (`RENDER_RATE`), 8 kHz for analysis (`ANALYSIS_RATE`).
Rendering speed is ~140× realtime at 8 kHz, ~50× at 22.05 kHz.

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | App identity, catalog counts, fingerprint index state |
| `GET` | `/api/catalog` | Tracks, artists, playlists, library, taste, stats |
| `GET` | `/api/tracks/:id` | One track + similar tracks + stream URL |
| `GET/POST` | `/api/search` | Hybrid AI search (`?q=` or `{query, limit}`) |
| `GET/HEAD` | `/api/stream/:id` | Seekable WAV, `Range` → 206, 416 when unsatisfiable |
| `POST` | `/api/identify` | PCM (header `x-sample-rate`) or WAV/multipart → candidates |
| `GET` | `/api/identify/status` | Fingerprint index build progress |
| `POST/GET` | `/api/online/search` | Public catalogue search (live + offline fallback) |
| `POST` | `/api/online/browse` | Render a page for the in-app browser |
| `POST` | `/api/online/download` | Copy/create audio into temp storage → token + TTL |
| `GET` | `/api/temp` | List active temporary downloads |
| `GET/DELETE` | `/api/temp/:token` | Stream (Range) / delete a temporary download |
| `GET` | `/api/library` | Likes, recents, playlists |
| `POST` | `/api/library` | `{action:"toggle-like", trackId}` |
| `GET/POST` | `/api/web/search` | Scrape mp3juice.sc (`?q=`) then fall back to the wider web |
| `POST` | `/api/web/play` | Save a hit (real title + URL), resolve lawful audio → playable track |
| `GET/DELETE` | `/api/web/tracks` | List / forget saved web songs (+ cached audio) |
| `GET/POST` | `/api/playlists` | List / create playlists |
| `GET/PATCH/DELETE` | `/api/playlists/:id` | Hydrated playlist (catalog + web tracks) · rename · delete |
| `POST` | `/api/playlists/:id/tracks` | Append a track or a `{ hit }` — saves title + song URL |
| `GET/POST` | `/api/events` | Play-event stream (powers analytics) |
| `GET` | `/api/analytics` | Aggregated listening stats + taste |
| `GET` | `/api/recommendations` | Radio + "made for you" rows (`?seed=&limit=`) |
| `POST` | `/api/ai/playlist` | Natural-language prompt → playlist (+ save) |

## Testing

```bash
npm test          # 1,601 cases, ~110 s
npm run verify    # typecheck + tests
```

| Suite | Cases | What it locks down |
| --- | --- | --- |
| `audio-synth` | 127 | purity, determinism, voice gating, WAV round-trips, resampling, pitch, per-track render |
| `fingerprint` | 130 | FFT vs naive DFT, spectrogram, peaks, hashing, matching, confidence, 24-track stability |
| `identify` | 188 | end-to-end identification for every track (clean, noisy, 3 s, wrong-rate, clipped, 0 dB SNR), edge cases, request decoding |
| `stream` | 73 | geometry, byte ranges (all alignments), header integrity, LRU, chunk stitching |
| `search` | 260 | index, embeddings, query parsing, filters, exact/typo/artist/genre/mood queries for all 24 tracks, NL scenarios |
| `catalog` | 472 | schema invariants for every track and artist |
| `library` | 52 | likes, events, playlists, analytics, streaks, taste, radio |
| `online` | 44 | providers, offline fallback, HTML extraction, in-app documents |
| `downloads` | 25 | TTL lifecycle, expiry, sweeps, concurrency, preview rendering |
| `api` | 79 | every route handler: happy path, validation, 404/400/416/410 |
| `ui` (jsdom) | 24 | shell renders, navigation, search flow, browser flow, download flow, player |

Notable behaviours the tests *prove* rather than assume:

* every one of the 24 tracks is identifiable from a noisy 6 s excerpt with a correct offset
* every track is findable by title, uppercase title, artist and a typo'd title
* range requests stitch back into a byte-identical WAV
* the download cache expires, sweeps and 410s correctly
* the UI renders and drives a full search → identify → download → playback flow in jsdom

## Performance notes

* Search: **~1–5 ms** for 24 tracks (index built once, ~2 ms, memoised process-wide via `globalThis`
  because Next bundles each route separately).
* Streaming: 1 MB range ≈ 20–30 ms of synthesis; a full track ≈ 1.6 s but is LRU-cached.
* Identify: fingerprint index load 160 ms from disk (or 16 s one-time build), query ≈ 40–80 ms.
* Fingerprint DB: 192k distinct hashes / 687k entries, 4.8 MB flat binary
  (`Uint32 hash | Uint16 time | Uint8 track`), loaded with a single typed-array view.

## Trade-offs

Matching the "trade-offs" box from the design sketch:

| Decision | Chosen | Why |
| --- | --- | --- |
| Consistency vs availability | **Availability** (JSON store, last-write-wins) | personal app, single writer per file, atomic temp-file renames |
| Latency vs cost | **Latency** | everything in-process, no network on the hot path |
| Storage vs redundancy | **Low storage** | audio is generated, not stored; only fingerprints are cached |
| Model quality vs dependency weight | **Deterministic local heuristics** | no API keys, offline by design, explainable, testable; swap `embedText` for a real model behind the same interface |
| Catalogue size vs honesty | **Small, original catalog** | 24 real, reproducible tracks instead of scraped streams; the online browser + temp download covers the rest |
| Perfect noise immunity vs truthfulness | **Refuse below 0.42 confidence** | better to say "no confident match" than to name the wrong song |

## Project layout

```
app/                      Next.js app router
  api/…                   20 route handlers (search, stream, identify, online, temp, …)
  layout.tsx, page.tsx, globals.css
src/
  components/             App shell, PlayerProvider, PlayerBar, OnlinePanel, views/*
  lib/
    types.ts              shared domain types
    util.ts               hashing, PRNG, shared process state
    storage.ts            JSON/binary store with serialised atomic writes
    catalog/tracks.ts     24 generated tracks + 12 artists
    audio/                synth · wav · fingerprint · stream · identify · tempo
    ai/                   text · embed · index (BM25) · understand · search
    online/               sources · downloads · mp3juice · web · resolve · weblibrary · webstream
    store/                library, playlists, events, analytics, radio
    client/               browser-side mic capture + PCM decode
scripts/build-index.ts    pre-build the fingerprint index
tests/                    13 suites, 1,601 cases (incl. jsdom UI suite)
instrumentation.ts        warms the fingerprint index at server boot
```

---

Built as a reference for what a "personal Spotify" looks like end to end: streaming, search,
recognition, an embedded web layer, and analytics — with no vendor account required.
