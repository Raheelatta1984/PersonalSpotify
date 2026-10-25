# SongHub — your personal Spotify, with AI ears

A complete, self-contained music streaming platform built from the system‑design sketch in
[`Screenshot_20261025_020020_Facebook.jpg`](./Screenshot_20261025_020020_Facebook.jpg):
clients → API gateway → microservice-style modules → data stores → event stream → analytics.

Everything runs locally with **zero external services, zero audio files and zero API keys**.

```
 Spotify design sketch            SongHub implementation
 ─────────────────────            ──────────────────────
 Music streaming, low latency  →  byte-range WAV streaming synthesised on demand (seek = free)
 Quality / downloads           →  MP3 32–320 kbps · WAV to 24-bit/48 kHz · MP4 240p–8K on your GPU
 Bollywood & filmi catalogue   →  13 Hindi filmi-style songs, searchable in English and Devanagari
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
3. [The headline features](#the-headline-features)
   - [1. AI-powered song search](#1-ai-powered-song-search)
   - [2. Hear it → identify it](#2-hear-it--identify-it)
   - [3. In-app browser → temporary download → play](#3-in-app-browser--temporary-download--play)
   - [4. Web music → play → playlist](#4-web-music--play--playlist-mp3juicesc)
   - [5. Bollywood & filmi shelf](#5-bollywood--filmi-shelf)
   - [6. Choosing quality: MP3, WAV, MP4 up to 8K](#6-choosing-quality-mp3-wav-mp4-up-to-8k)
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
| **Library** | 37 original tracks across 18 artists — all *generated* by a synth engine, so there's no sample licensing and playback is byte-identical every time. |
| **Bollywood & filmi** | A dedicated Hindi shelf: 13 filmi-style songs (romance, sangeet, sufi/ghazal) with Devanagari titles, bansuri/tabla/sitar voices and raga scales, searchable as `hindi love song`, `बारिश की चादर` or `sufi qawwali`. |
| **Quality ladder** | One picker in the player: MP3 **32 → 320 kbps** (data-saver first) and WAV up to **24-bit/48 kHz**. Switch mid-song without losing your place; the choice is remembered. |
| **Download & video** | Download any track as **MP3 or WAV**, or export a **video song as MP4** from 240p to **8K** — H.264 + AAC encoded on your own GPU. |
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
* **Bollywood** → open the shelf, try `बारिश की चादर`, `sufi qawwali` or the "Sangeet & dance" scene
* **Quality** → play anything, then change the picker in the player bar (MP3 32 kbps → WAV 24-bit),
  or open **⤓ Quality & downloads** for MP3/WAV downloads and an MP4 export up to 8K

Useful scripts:

```bash
npm run dev        # dev server (0.0.0.0:3000)
npm run build      # production build
npm run start      # production server
npm run typecheck  # tsc --noEmit
npm run test       # 2,241 tests across 16 suites
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
  peak at the true offset. Votes are **IDF-weighted** (`1/√document-frequency`): a hash shared by
  twenty tracks is cheap evidence, a distinctive one is expensive, which is what keeps a
  37-track index exact where a plain count ties on synth timbres. Confidence is a saturating
  function of votes and margin (`confidenceFromVotes`), and the endpoint refuses to claim a match
  below 0.42.
* **Benchmarks** (in the test suite): 37/37 tracks identified from clean 3 s and 6 s excerpts,
  from room-noise clips and from 5 s excerpts, offsets within ~2 s, graceful degradation down to
  ~0 dB SNR (true track still in the shortlist).
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

### 5. Bollywood & filmi shelf

```
  Nav: Bollywood ─► BollywoodView ─► 13 filmi-style songs, three scene filters
                                     ├── Romance         (chandni, baarish, pyaar)
                                     ├── Sangeet & dance (mehndi, shaadi, celebration)
                                     └── Sufi & ghazal   (ishq, rangreza, dua)
                                          └─► English title + Devanagari nativeTitle
```

* **The songs** — 13 tracks from six filmi artists (Monsoon Cinema, Ravi Deshmukh,
  Bombay Transit, Saanjh Collective, Zoya Qureshi, Meher Kaul) with `language: "hi"` and a
  Devanagari `nativeTitle`: *Baarish Ki Chaadar* / बारिश की चादर, *Ishq Nagari* / इश्क़ नगरी,
  *Rangreza* / रंगरेज़ा, *Mehndi Raat* / मेहंदी रात, and so on.
* **The sound** — three raga scales (`bhairavi`, `kirwani`, `khamaj`) on top of the same
  deterministic engine, using the filmi voices: **bansuri** (flute), **tabla**, **sitar**,
  **strings** and shimmer alongside pad/bass/drums. Each track keeps a `bpm`, `root` and
  progression, so the shelf sounds like a record, not a preset.
* **Finding them** — the search index tokenises Devanagari as well as Latin script, so
  `bollywood`, `hindi love song`, `sufi qawwali`, `sangeet`, `item song`, `बारिश की चादर` and
  `इश्क़` all land on the right song. Curated library playlists **Bollywood Nights** and
  **Sangeet Night** collect them.
* **Identifying them** — they live in the same fingerprint index as everything else, so humming
  a filmi hook into the mic identifies it like any other track.
* **Honesty about rights** — these are *original* arrangements written in filmi style, not copies
  of commercial masters. Real Bollywood recordings you are licensed to hear come in through the
  lawful web-music path (§4): SongHub only plays audio the rights-holder publishes, or its own
  synthesised preview.

### 6. Choosing quality: MP3, WAV, MP4 up to 8K

Every rung is a **fresh render of the same song** — the ladder is not a set of stored files:

| Rung | `?q=` | What you get |
| --- | --- | --- |
| very low · data saver | `mp3-32` | 32 kbps @ 22.05 kHz — ~0.4 MB per 90 s |
| low · data saver | `mp3-64` | 64 kbps @ 32 kHz — the prepaid-data sweet spot |
| standard | `mp3-96` | 96 kbps @ 44.1 kHz |
| **default** | `mp3-128` | 128 kbps @ 44.1 kHz |
| high | `mp3-192` | 192 kbps @ 44.1 kHz |
| very high | `mp3-320` | 320 kbps @ 48 kHz |
| WAV (recorder) | `wav-22` | 22.05 kHz 16-bit PCM |
| WAV (CD) | `wav-44` | 44.1 kHz 16-bit PCM |
| WAV (video) | `wav-48` | 48 kHz 16-bit PCM |
| WAV (master) | `wav-48-24` | 48 kHz **24-bit** PCM |

Video rungs for MP4 export (`VIDEO_QUALITIES`): **240p** (24 fps, 350 kbps) → 360p → 480p →
720p → 1080p → 1440p → **4K** (3840×2160) → **8K** (7680×4320). 1440p and above are flagged
`heavy` and the UI warns before starting.

```
 MP3/WAV  (server)                     MP4  (your browser)
 /api/stream/:id?q=mp3-64              canvas visualiser ─► VideoEncoder (H.264, 240p–8K)
   └─ render → LAME-style encode         PCM from the decoded stream ─► AudioEncoder (AAC)
      └─ streamed as it renders,         └─ mp4-muxer (fastStart) ─► Blob ─► download
         Range-enabled once cached
```

* **Switching mid-song** keeps the playhead: `setQuality` rewrites the stream URL, waits for
  `loadedmetadata`, restores `currentTime`, and resumes if you were playing. The choice persists
  in `localStorage` (`songhub.quality`).
* **Low-data use** is a first-class rung, not a buried setting: the picker labels the 32/64 kbps
  rungs *data saver*, the downloads panel prints the honest size of every rung (`717 KB` for
  3 minutes at 32 kbps vs `24.7 MB` for the same song as 24-bit WAV), and `X-Data-Saver` /
  `X-Bitrate` / `X-Quality` headers travel with every response.
* **Downloads** (`/api/download/:id?q=…`) send `Content-Disposition` names like
  `Zoya Qureshi - Ishq Nagari - 320kbps.mp3` / `… - 48k-24bit.wav`, so a right-click "save" and
  the in-app button produce the same file.
* **Why MP4 is client-side**: Node has no `AudioEncoder`, and H.264 at 4K/8K is exactly the work
  a GPU should do. `mp4Support()` probes `VideoEncoder.isConfigSupported` for the chosen
  resolution and, if the browser cannot do it, the panel says so instead of handing you a broken
  file.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  clients (React 19 / Next 16 app router)                                      │
│  Home · AI Search · Identify · Web+Browser · Library · Analytics · PlayerBar   │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ fetch (JSON + binary PCM)
┌───────────────────────────────▼───────────────────────────────────────────────┐
│  "API gateway" = Next route handlers (rate-limit-friendly, CORS headers)      │
│  /api/search /api/identify /api/stream /api/download /api/qualities  …        │
└───┬────────────┬──────────────┬───────────────┬──────────────┬────────────────┘
    │            │              │               │              │
┌───▼──────┐ ┌───▼────────┐ ┌───▼──────────┐ ┌──▼──────────┐ ┌▼──────────────┐
│ catalog  │ │ AI service │ │ audio service│ │ online svc  │ │ personal svc  │
│ tracks + │ │ understand │ │ synth (WAV)  │ │ providers   │ │ likes, lists, │
│ artists  │ │ index BM25 │ │ MP3/WAV/MP4  │ │ browser     │ │ events, taste │
│ 37/18    │ │ embeddings │ │ identify     │ │ temp cache  │ │ analytics     │
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
  voices: { pad, bass, arp, drums, pluck, shimmer, strings, flute, tabla, sitar } }
```

Scales include the Western modes plus three ragas (`bhairavi`, `kirwani`, `khamaj`) used by the
Bollywood shelf.

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
Rendering speed is ~140× realtime at 8 kHz, ~50× at 22.05 kHz, ~27× at 44.1/48 kHz.

### Format ladder

The synth is the only source, so every output format is produced on demand:

* **MP3** (`src/lib/audio/mp3.ts`) — a pure-JS LAME port (`@breezystack/lamejs`) drives a
  single-channel encoder at the rung's sample rate; the route streams chunks as they leave the
  encoder, so playback starts in well under a second. A 30 s 128 kbps encode takes ~0.7 s.
* **WAV** (`src/lib/audio/wav.ts`, `stream.ts`) — 16- and 24-bit PCM at 22.05/44.1/48 kHz.
  Because the file is a pure function of time, 24-bit WAV stays byte-range addressable: a seek is
  as cheap as the first second, even for a 12 MB file.
* **MP4** (`src/lib/client/mp4-export.ts`) — a canvas visualiser is drawn per frame and encoded
  with WebCodecs (`VideoEncoder` H.264 + `AudioEncoder` AAC), then muxed by `mp4-muxer` with
  `fastStart` so the file plays before it is fully downloaded. Resolution is the user's choice
  from 240p to 8K; `mp4Support()` refuses politely when the browser cannot encode it.
* Everything is cached in a 64 MB / 32-entry LRU (`encode.ts`) and regenerated on demand — the
  repository still contains zero audio files.

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | App identity, catalog counts, fingerprint index state |
| `GET` | `/api/catalog` | Tracks, artists, playlists, library, taste, stats |
| `GET` | `/api/tracks/:id` | One track + similar tracks + stream URL |
| `GET/POST` | `/api/search` | Hybrid AI search (`?q=` or `{query, limit}`) |
| `GET/HEAD` | `/api/stream/:id` | Seekable WAV by default; `?q=mp3-32`…`wav-48-24` for the quality ladder; `Range` → 206, 416 when unsatisfiable |
| `GET` | `/api/download/:id` | Download the same track as MP3 or WAV (`?q=`), with a `Content-Disposition` filename |
| `GET` | `/api/qualities` | Audio ladder + MP4 resolutions, with byte sizes and data-saving % for a track (`?id=`) |
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
npm test            # 2,241 cases across 16 suites, ~150 s
npm run verify      # typecheck + tests
npm run test:audio  # synth + fingerprint + identify only
npm run test:ui     # the jsdom UI suite
```

| Suite | Cases | What it locks down |
| --- | --- | --- |
| `audio-synth` | 166 | purity, determinism, voice gating (incl. bansuri/tabla/sitar), WAV round-trips, resampling, per-track render |
| `fingerprint` | 182 | FFT vs naive DFT, spectrogram, peaks, hashing, IDF-weighted matching, confidence, 37-track stability |
| `identify` | 279 | end-to-end identification for every track (clean, noisy, 3 s, wrong-rate, clipped, 0 dB SNR), edge cases, request decoding |
| `stream` | 99 | geometry, byte ranges (all alignments), header integrity, LRU, chunk stitching, MP3/WAV per-track integrity |
| `search` | 351 | index, embeddings, query parsing, filters, exact/typo/artist/genre/mood queries across the catalog, Devanagari queries, NL scenarios |
| `catalog` | 724 | schema invariants for every track and artist, including the Bollywood shelf |
| `quality` | 37 | the ladder (32 kbps → 24-bit WAV), MP3 framing/ID3, WAV headers, size estimates, per-rung encoding |
| `bollywood` | 20 | the shelf is populated, Hindi metadata is valid, every filmi track sounds, searches and identifies |
| `mp4-export` | 10 | WebCodecs orchestration with a stubbed encoder: frame count/timestamps, encoder config per resolution, AAC muxing, progress, cancel, no-WebCodecs refusal |
| `library` | 52 | likes, events, playlists, analytics, streaks, taste, radio |
| `online` | 44 | providers, offline fallback, HTML extraction, in-app documents |
| `downloads` | 25 | TTL lifecycle, expiry, sweeps, concurrency, preview rendering |
| `api` | 94 | every route handler: happy path, validation, 404/400/416/410 |
| `ui` (jsdom) | 34 | shell, navigation, search/identify/download flows, the Bollywood shelf, the quality picker and its persistence |
| `web-music` | 62 | mp3juice scraping, fallback chain, resolve/save/stream of web songs |
| `text` | 62 | tokeniser (Unicode-aware), stemmer, fuzzy scores, lexicon |

Notable behaviours the tests *prove* rather than assume:

* every one of the 37 tracks is identifiable from a noisy 6 s excerpt with a correct offset
* every track is findable by title, uppercase title, artist and a typo'd title — and the Hindi
  shelf by Devanagari title, `hindi love song`, `sufi qawwali` or `bollywood`
* range requests stitch back into a byte-identical WAV, at 16- and 24-bit
* each MP3 rung is a valid MPEG frame stream with the bitrate it advertises
* the download cache expires, sweeps and 410s correctly
* the UI renders and drives a full search → identify → download → playback flow in jsdom, and
  switching quality mid-song keeps the song playing
* the MP4 exporter emits one video chunk per frame at the requested resolution, muxes AAC audio,
  reports monotonic progress and cancels cleanly

## Performance notes

* Search: **~1–5 ms** for 37 tracks (index built once, ~2 ms, memoised process-wide via `globalThis`
  because Next bundles each route separately).
* Streaming: 1 MB range ≈ 20–30 ms of synthesis; a full 86 s track ≈ 1.6 s at 22.05 kHz,
  ≈ 3.3 s at 44.1 kHz, ≈ 3.6 s at 48 kHz — and it stays in the LRU afterwards.
* Encoding: full-track MP3 ≈ 6.8 s of CPU, 22.05 kHz WAV ≈ 3.1 s. MP3 is streamed, so the first
  audio arrives long before the encode finishes. 30 s at 128 kbps = 480 KB in ≈ 730 ms.
* Identify: fingerprint index load 160 ms from disk (or ~30 s one-time build), query ≈ 40–80 ms.
* Fingerprint DB: 1,133,630 hash entries for 37 tracks, flat binary
  (`Uint32 hash | Uint16 time | Uint8 track`), loaded with a single typed-array view and keyed
  to the catalogue by a `catalogSignature` so a changed spec can never be matched against a
  stale index.
* MP4 export: dominated by the user's GPU — 1080p visualises at roughly real time on a laptop,
  4K/8K are minutes per song (which is why the panel warns and allows a short clip).

## Trade-offs

Matching the "trade-offs" box from the design sketch:

| Decision | Chosen | Why |
| --- | --- | --- |
| Consistency vs availability | **Availability** (JSON store, last-write-wins) | personal app, single writer per file, atomic temp-file renames |
| Latency vs cost | **Latency** | everything in-process, no network on the hot path |
| Storage vs redundancy | **Low storage** | audio is generated, not stored; only fingerprints are cached |
| Model quality vs dependency weight | **Deterministic local heuristics** | no API keys, offline by design, explainable, testable; swap `embedText` for a real model behind the same interface |
| Catalogue size vs honesty | **Original catalog, growing** | 37 reproducible tracks (13 Hindi filmi-style) instead of scraped streams; the online browser + temp download covers the rest |
| Where video is encoded | **In the browser (WebCodecs)** | Node has no `AudioEncoder`, and H.264 at 4K/8K is GPU work; the server only ever serves audio |
| Fingerprint scoring | **IDF-weighted votes (`1/√df`)** | synth timbres repeat across tracks, so hashes shared by 20 songs must not outvote the distinctive ones — this is what keeps a 37-track index exact |
| Bollywood content | **Original filmi-style arrangements** | Hindi titles, ragas and bansuri/tabla/sitar voices written from scratch; real masters stay on the lawful web path |
| Perfect noise immunity vs truthfulness | **Refuse below 0.42 confidence** | better to say "no confident match" than to name the wrong song |

## Project layout

```
app/                      Next.js app router
  api/…                   25 route handlers (search, stream, download, qualities, identify, online, temp, …)
  layout.tsx, page.tsx, globals.css
src/
  components/             App shell, PlayerProvider, PlayerBar, QualityPanel, OnlinePanel, views/*
  lib/
    types.ts              shared domain types
    util.ts               hashing, PRNG, shared process state
    storage.ts            JSON/binary store with serialised atomic writes
    catalog/tracks.ts     37 generated tracks + 18 artists (13 Bollywood, Devanagari titles)
    audio/                synth · wav · mp3 · quality · encode · fingerprint · stream · identify · tempo
    ai/                   text · embed · index (BM25) · understand · search
    online/               sources · downloads · mp3juice · web · resolve · weblibrary · webstream
    store/                library, playlists, events, analytics, radio
    client/               mic capture + PCM decode · mp4-export (WebCodecs + mp4-muxer)
scripts/build-index.ts    pre-build the fingerprint index
tests/                    16 suites, 2,241 cases (incl. jsdom UI suite)
instrumentation.ts        warms the fingerprint index at server boot
```

---

Built as a reference for what a "personal Spotify" looks like end to end: streaming, search,
recognition, an embedded web layer, and analytics — with no vendor account required.
