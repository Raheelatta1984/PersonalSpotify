"use client";

import { OnlinePanel } from "../OnlinePanel";

export function OnlineView() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">⇗ Web search &amp; browser</h1>
          <p className="page-sub">
            SongHub searches public music catalogues (iTunes, Internet Archive, Jamendo). Open any result inside the
            built-in browser, then download it to temporary storage and play it from the local copy — the file is
            deleted automatically when the timer runs out.
          </p>
        </div>
      </div>
      <OnlinePanel />
    </div>
  );
}
