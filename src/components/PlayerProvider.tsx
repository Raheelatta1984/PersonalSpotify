"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { DEFAULT_QUALITY, resolveQuality } from "@/lib/audio/quality";

export interface NowPlaying {
  /** Track id when the source is the local catalog. */
  id: string | null;
  title: string;
  artist: string;
  album?: string;
  palette: [string, string];
  src: string;
  /** Set when the audio is a temporary online download (auto-expires). */
  tempToken?: string;
  expiresAt?: string;
  origin: "catalog" | "temp";
  /** Quality rung requested from `/api/stream` (catalog tracks only). */
  quality?: string;
}

interface Toast {
  id: number;
  message: string;
  tone: "ok" | "err" | "info";
}

interface PlayerContextValue {
  current: NowPlaying | null;
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: "off" | "one" | "all";
  /** Playback rung for synthesised tracks (see `src/lib/audio/quality.ts`). */
  quality: string;
  queue: NowPlaying[];
  queueOpen: boolean;
  toasts: Toast[];
  playTrack: (track: Track, queue?: Track[], source?: string) => void;
  playNowPlaying: (item: NowPlaying, source?: string) => void;
  playQueue: (items: NowPlaying[], source?: string) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setQuality: (qualityId: string) => void;
  enqueue: (track: Track) => void;
  clearQueue: () => void;
  setQueueOpen: (open: boolean) => void;
  removeFromQueue: (index: number) => void;
  toast: (message: string, tone?: Toast["tone"]) => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}

/** Stream URL for a catalog track at a given quality rung. */
export function streamSrcFor(trackId: string, qualityId?: string): string {
  return qualityId ? `/api/stream/${trackId}?q=${encodeURIComponent(qualityId)}` : `/api/stream/${trackId}`;
}

export function nowPlayingFromTrack(track: Track, qualityId?: string): NowPlaying {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    palette: track.palette,
    src: streamSrcFor(track.id, qualityId),
    origin: "catalog",
    quality: qualityId,
  };
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playedMsRef = useRef(0);
  const lastTickRef = useRef(0);
  const [current, setCurrent] = useState<NowPlaying | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "one" | "all">("all");
  const [quality, setQualityState] = useState<string>(DEFAULT_QUALITY);
  const [queue, setQueue] = useState<NowPlaying[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sourceRef = useRef<string>("home");
  const qualityRef = useRef<string>(quality);
  qualityRef.current = quality;

  // Restore the rung the listener picked last time.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("songhub.quality");
      const resolved = resolveQuality(stored);
      if (resolved) setQualityState(resolved.id);
    } catch {
      /* private mode / storage disabled */
    }
  }, []);

  const toast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3800);
  }, []);

  /* ------------------------------------------------------------ audio el */
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = volume;
    audioRef.current = audio;

    const onTime = () => {
      setTime(audio.currentTime);
      const now = Date.now();
      if (lastTickRef.current && !audio.paused) {
        playedMsRef.current += Math.min(now - lastTickRef.current, 1200);
      }
      lastTickRef.current = now;
    };
    const onLoaded = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => {
      setPlaying(true);
      lastTickRef.current = Date.now();
    };
    const onPause = () => {
      setPlaying(false);
      lastTickRef.current = 0;
    };
    const onEnded = () => {
      setPlaying(false);
      flushPlay();
      setTime(0);
      advance(1);
    };
    const onError = () => {
      setPlaying(false);
      toast("Playback failed — the audio source could not be loaded.", "err");
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("durationchange", onLoaded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushPlay = useCallback(() => {
    const item = currentRef.current;
    const ms = Math.round(playedMsRef.current);
    playedMsRef.current = 0;
    if (!item || item.origin !== "catalog" || !item.id || ms < 800) return;
    fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: item.id, msPlayed: ms, source: sourceRef.current }),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  // keep a ref of the current item so the audio listeners stay stable
  const currentRef = useRef<NowPlaying | null>(null);
  currentRef.current = current;
  const queueRef = useRef<NowPlaying[]>([]);
  queueRef.current = queue;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;

  const load = useCallback(
    (item: NowPlaying, autoPlay = true) => {
      const audio = audioRef.current;
      if (!audio) return;
      flushPlay();
      playedMsRef.current = 0;
      lastTickRef.current = Date.now();
      setCurrent(item);
      setTime(0);
      setDuration(0);
      audio.src = item.src;
      audio.load();
      if (autoPlay) {
        audio
          .play()
          .then(() => {
            if (item.origin === "catalog" && item.id) {
              fetch("/api/events", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ trackId: item.id, msPlayed: 0, source: sourceRef.current }),
                keepalive: true,
              }).catch(() => undefined);
            }
          })
          .catch(() => {
            setPlaying(false);
            toast("Tap play again to start audio (browser autoplay policy).", "info");
          });
      }
    },
    [flushPlay, toast],
  );

  const advance = useCallback(
    (direction: 1 | -1) => {
      const items = queueRef.current;
      if (!items.length) return;
      const idx = items.findIndex((i) => i.src === currentRef.current?.src);
      if (direction === 1 && repeatRef.current === "one" && currentRef.current) {
        const audio = audioRef.current;
        if (audio) {
          audio.currentTime = 0;
          void audio.play();
        }
        return;
      }
      let nextIdx: number;
      if (shuffleRef.current && direction === 1) {
        nextIdx = Math.floor(Math.random() * items.length);
      } else {
        nextIdx = idx + direction;
        if (nextIdx >= items.length) nextIdx = repeatRef.current === "all" ? 0 : -1;
        if (nextIdx < 0) {
          if (direction === -1 && items.length) nextIdx = items.length - 1;
          else {
            setPlaying(false);
            return;
          }
        }
      }
      const nextItem = items[nextIdx];
      if (nextItem) load(nextItem, true);
    },
    [load],
  );

  /* --------------------------------------------------------- public API */
  const playTrack = useCallback(
    (track: Track, list?: Track[], source = "home") => {
      sourceRef.current = source;
      const items = list && list.length ? list : [track];
      const mapped = items.map((t) => nowPlayingFromTrack(t, qualityRef.current));
      setQueue(mapped);
      const item = mapped.find((i) => i.id === track.id) ?? nowPlayingFromTrack(track, qualityRef.current);
      load(item, true);
    },
    [load],
  );

  const playNowPlaying = useCallback(
    (item: NowPlaying, source = "online") => {
      sourceRef.current = source;
      setQueue((prev) => (prev.some((p) => p.src === item.src) ? prev : [...prev, item]));
      load(item, true);
    },
    [load],
  );

  const playQueue = useCallback(
    (items: NowPlaying[], source = "queue") => {
      if (!items.length) return;
      sourceRef.current = source;
      setQueue(items);
      load(items[0], true);
    },
    [load],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentRef.current) return;
    if (audio.paused) void audio.play().catch(() => toast("Playback was blocked by the browser.", "err"));
    else audio.pause();
  }, [toast]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, seconds);
    setTime(seconds);
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    setMuted(v === 0);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const nextMuted = !prev;
      if (audioRef.current) audioRef.current.muted = nextMuted;
      return nextMuted;
    });
  }, []);

  const enqueue = useCallback(
    (track: Track) => {
      const item = nowPlayingFromTrack(track, qualityRef.current);
      setQueue((prev) => (prev.some((p) => p.src === item.src) ? prev : [...prev, item]));
      toast(`Added “${track.title}” to the queue.`, "ok");
    },
    [toast],
  );

  /**
   * Switch rung mid-song: rebuild the stream URL, keep the playhead, and resume
   * if we were playing. The queue is rewritten too so "next" stays consistent.
   */
  const setQuality = useCallback(
    (qualityId: string) => {
      const next = resolveQuality(qualityId);
      if (!next) return;
      setQualityState(next.id);
      qualityRef.current = next.id;
      try {
        window.localStorage.setItem("songhub.quality", next.id);
      } catch {
        /* storage disabled */
      }

      setQueue((prev) =>
        prev.map((item) => (item.origin === "catalog" && item.id ? { ...item, src: streamSrcFor(item.id, next.id), quality: next.id } : item)),
      );

      const audio = audioRef.current;
      const currentItem = currentRef.current;
      if (!audio || !currentItem || currentItem.origin !== "catalog" || !currentItem.id) {
        toast(`Audio quality set to ${next.label}.`, "ok");
        return;
      }

      const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const wasPlaying = !audio.paused;
      const updated: NowPlaying = { ...currentItem, src: streamSrcFor(currentItem.id, next.id), quality: next.id };
      setCurrent(updated);
      audio.src = updated.src;
      audio.load();
      audio.addEventListener(
        "loadedmetadata",
        () => {
          try {
            audio.currentTime = at;
          } catch {
            /* seeking not ready yet */
          }
          if (wasPlaying) void audio.play().catch(() => undefined);
        },
        { once: true },
      );
      toast(
        `Quality ${next.label}${next.dataSaver ? " · data saver" : ""} — same song, ${next.sampleRate / 1000} kHz render.`,
        "ok",
      );
    },
    [toast],
  );

  const value = useMemo<PlayerContextValue>(
    () => ({
      current,
      playing,
      time,
      duration,
      volume,
      muted,
      shuffle,
      repeat,
      quality,
      queue,
      queueOpen,
      toasts,
      playTrack,
      playNowPlaying,
      playQueue,
      toggle,
      next: () => advance(1),
      prev: () => advance(-1),
      seek,
      setVolume,
      toggleMute,
      toggleShuffle: () => setShuffle((v) => !v),
      cycleRepeat: () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
      setQuality,
      enqueue,
      clearQueue: () => setQueue(current ? [current] : []),
      setQueueOpen,
      removeFromQueue: (index: number) => setQueue((prev) => prev.filter((_, i) => i !== index)),
      toast,
    }),
    [current, playing, time, duration, volume, muted, shuffle, repeat, quality, queue, queueOpen, toasts, playTrack, playNowPlaying, playQueue, toggle, advance, seek, setVolume, toggleMute, setQuality, enqueue, toast],
  );

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        toggle();
      }
      if (event.key === "ArrowRight" && event.shiftKey) advance(1);
      if (event.key === "ArrowLeft" && event.shiftKey) advance(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, advance]);

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
