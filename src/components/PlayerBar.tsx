"use client";

import { usePlayer } from "./PlayerProvider";
import { Cover, formatTime } from "./ui";

export function PlayerBar() {
  const player = usePlayer();
  const { current, playing, time, duration } = player;
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;

  return (
    <footer className="player">
      <div className="player-track">
        {current ? (
          <>
            <Cover palette={current.palette} className="player-art" style={{ width: 52, height: 52 }} />
            <div style={{ minWidth: 0 }}>
              <div className="player-title">{current.title}</div>
              <div className="player-artist">
                {current.artist}
                {current.origin === "temp" ? " · temporary" : ""}
              </div>
            </div>
            {playing ? (
              <div className="equalizer" aria-hidden>
                <span /> <span /> <span /> <span />
              </div>
            ) : null}
          </>
        ) : (
          <div className="player-artist">Nothing playing yet — press play on any track.</div>
        )}
      </div>

      <div className="player-center">
        <div className="player-controls">
          <button className={`ctrl ${player.shuffle ? "on" : ""}`} onClick={player.toggleShuffle} title="Shuffle" aria-label="Shuffle">
            ⇄
          </button>
          <button className="ctrl" onClick={player.prev} title="Previous" aria-label="Previous">
            ◀
          </button>
          <button className="ctrl play" onClick={player.toggle} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button className="ctrl" onClick={player.next} title="Next" aria-label="Next">
            ▶
          </button>
          <button
            className={`ctrl ${player.repeat !== "off" ? "on" : ""}`}
            onClick={player.cycleRepeat}
            title={`Repeat: ${player.repeat}`}
            aria-label="Cycle repeat"
          >
            {player.repeat === "one" ? "↻¹" : "↻"}
          </button>
        </div>
        <div className="progress-row">
          <span className="time">{formatTime(time)}</span>
          <div
            className="scrub"
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            tabIndex={0}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              player.seek(((event.clientX - rect.left) / rect.width) * duration);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") player.seek(time + 5);
              if (event.key === "ArrowLeft") player.seek(Math.max(0, time - 5));
            }}
          >
            <div className="scrub-fill" style={{ width: `${progress * 100}%` }} />
            <div className="scrub-knob" style={{ left: `${progress * 100}%` }} />
          </div>
          <span className="time">{formatTime(duration || 0)}</span>
        </div>
      </div>

      <div className="player-right">
        <button className="ctrl" onClick={() => player.setQueueOpen(!player.queueOpen)} title="Queue" aria-label="Queue">
          ☰ {player.queue.length}
        </button>
        <button className="ctrl" onClick={player.toggleMute} title={player.muted ? "Unmute" : "Mute"} aria-label="Mute">
          {player.muted || player.volume === 0 ? "🔇" : "🔊"}
        </button>
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.volume}
          onChange={(event) => player.setVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>
    </footer>
  );
}
