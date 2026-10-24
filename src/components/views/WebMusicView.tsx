"use client";

import { WebMusicPanel } from "../WebMusicPanel";

export function WebMusicView() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">♫ Web music</h1>
          <p className="page-sub">
            Search everything on <strong>mp3juice.sc</strong>. Play any result right here, or add it to a playlist —
            the real song title and its source URL are saved together. If the site has nothing, SongHub searches the
            wider web automatically.
          </p>
        </div>
      </div>
      <WebMusicPanel />
    </div>
  );
}
