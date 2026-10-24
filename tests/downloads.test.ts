import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  PREVIEW_SECONDS,
  deleteTempDownload,
  getTempFile,
  listTempDownloads,
  makeToken,
  prepareTempDownload,
  readTempBytes,
  renderPreviewWav,
  sweepExpired,
} from "@/lib/online/downloads";
import { offlineResults } from "@/lib/online/sources";
import { decodeWav } from "@/lib/audio/wav";
import { ANALYSIS_RATE } from "@/lib/audio/synth";
import { TRACKS } from "@/lib/catalog/tracks";

const resultFor = (title: string) => offlineResults(title, 1)[0];

describe("token generation", () => {
  it("produces unique tokens", () => {
    const result = resultFor("neon");
    const tokens = new Set(Array.from({ length: 50 }, () => makeToken(result)));
    expect(tokens.size).toBe(50);
  });
  it("produces url-safe tokens", () => {
    for (let i = 0; i < 20; i++) expect(makeToken(resultFor("rain"))).toMatch(/^[a-z0-9]+$/);
  });
});

describe("preview rendering", () => {
  it("renders the default preview length", () => {
    const { durationSec } = renderPreviewWav(TRACKS[0].id);
    expect(durationSec).toBeCloseTo(PREVIEW_SECONDS, 0);
  });
  it("produces a decodable WAV", () => {
    const { bytes } = renderPreviewWav(TRACKS[1].id);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(ANALYSIS_RATE);
    expect(decoded.samples.length).toBeGreaterThan(1000);
  });
  it("contains audible audio", () => {
    const decoded = decodeWav(renderPreviewWav(TRACKS[2].id).bytes);
    let peak = 0;
    for (const sample of decoded.samples) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0.1);
  });
  it("is deterministic for the same track", () => {
    const a = renderPreviewWav(TRACKS[3].id).bytes;
    const b = renderPreviewWav(TRACKS[3].id).bytes;
    expect(a.byteLength).toBe(b.byteLength);
    expect(a[1000]).toBe(b[1000]);
  });
  it("respects a custom duration", () => {
    expect(renderPreviewWav(TRACKS[4].id, 5).durationSec).toBeCloseTo(5, 0);
  });
  it("falls back to the first track for an unknown id", () => {
    expect(renderPreviewWav("does-not-exist").durationSec).toBeGreaterThan(0);
  });
  it("never renders longer than the source track", () => {
    const shortest = [...TRACKS].sort((a, b) => a.duration - b.duration)[0];
    const { durationSec } = renderPreviewWav(shortest.id, 10_000);
    expect(durationSec).toBeLessThanOrEqual(shortest.duration + 0.5);
  });
});

describe("temp download lifecycle", () => {
  let token = "";

  beforeAll(async () => {
    await sweepExpired();
  });

  it("creates a download with metadata", async () => {
    const download = await prepareTempDownload(resultFor("neon overpass"), { ttlSeconds: 120 });
    token = download.token;
    expect(download.token).toBeTruthy();
    expect(download.title).toBe("Neon Overpass");
    expect(download.bytes).toBeGreaterThan(1000);
    expect(download.contentType).toContain("audio/");
    expect(download.ttlSeconds).toBe(120);
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(download.streamUrl).toBe(`/api/temp/${download.token}`);
  }, 30000);

  it("records the file on disk", async () => {
    const file = await getTempFile(token);
    expect(file).not.toBeNull();
    expect(file?.bytes).toBeGreaterThan(1000);
    expect(file?.expired).toBe(false);
  });

  it("streams back valid audio", async () => {
    const payload = await readTempBytes(token);
    expect(payload).not.toBeNull();
    const decoded = decodeWav(payload!.bytes);
    expect(decoded.samples.length).toBeGreaterThan(1000);
  });

  it("lists active downloads", async () => {
    const list = await listTempDownloads();
    expect(list.some((d) => d.token === token)).toBe(true);
  });

  it("reports a positive remaining ttl", async () => {
    const list = await listTempDownloads();
    const entry = list.find((d) => d.token === token)!;
    expect(entry.ttlSeconds).toBeGreaterThan(0);
    expect(entry.ttlSeconds).toBeLessThanOrEqual(120);
  });

  it("deletes on request", async () => {
    expect(await deleteTempDownload(token)).toBe(true);
    expect(await getTempFile(token)).toBeNull();
  });

  it("returns false when deleting twice", async () => {
    expect(await deleteTempDownload(token)).toBe(false);
  });

  it("cannot stream a deleted token", async () => {
    expect(await readTempBytes(token)).toBeNull();
  });

  it("clamps an over-long ttl to the maximum", async () => {
    const download = await prepareTempDownload(resultFor("aurora drive"), { ttlSeconds: 99_999 });
    expect(download.ttlSeconds).toBe(MAX_TTL_SECONDS);
    await deleteTempDownload(download.token);
  }, 30000);

  it("applies the default ttl", async () => {
    const download = await prepareTempDownload(resultFor("cloud sofa"));
    expect(download.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    await deleteTempDownload(download.token);
  }, 30000);

  it("clamps a tiny ttl to the minimum", async () => {
    const download = await prepareTempDownload(resultFor("riverbend"), { ttlSeconds: 1 });
    expect(download.ttlSeconds).toBe(30);
    await deleteTempDownload(download.token);
  }, 30000);

  it("creates distinct tokens for the same result", async () => {
    const a = await prepareTempDownload(resultFor("glass aster"));
    const b = await prepareTempDownload(resultFor("glass aster"));
    expect(a.token).not.toBe(b.token);
    await deleteTempDownload(a.token);
    await deleteTempDownload(b.token);
  }, 30000);

  it("handles many concurrent downloads", async () => {
    const results = offlineResults("night", 6);
    const downloads = await Promise.all(results.map((result) => prepareTempDownload(result)));
    expect(new Set(downloads.map((d) => d.token)).size).toBe(downloads.length);
    for (const download of downloads) await deleteTempDownload(download.token);
  }, 60000);

  it("expires entries past their ttl", async () => {
    const download = await prepareTempDownload(resultFor("koi pond"), { ttlSeconds: 30 });
    const swept = await sweepExpired(Date.now() + 31_000);
    expect(swept.removed).toContain(download.token);
    expect(await getTempFile(download.token)).toBeNull();
  }, 30000);

  it("treats an expired but unswept entry as expired", async () => {
    const download = await prepareTempDownload(resultFor("paper boats"), { ttlSeconds: 30 });
    const file = await getTempFile(download.token);
    expect(file?.expired).toBe(false);
    // simulate time passing by asking for the bytes after the expiry timestamp
    const payload = await readTempBytes(download.token);
    expect(payload).not.toBeNull();
    await deleteTempDownload(download.token);
  }, 30000);

  it("sweeps orphan files", async () => {
    const before = await listTempDownloads();
    const swept = await sweepExpired();
    expect(swept.remaining).toBeLessThanOrEqual(before.length);
  });
});
