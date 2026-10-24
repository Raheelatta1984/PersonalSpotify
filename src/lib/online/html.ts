/**
 * Dependency-free HTML helpers shared by the scrapers.
 *
 * The app never renders remote HTML directly (no iframe, no DOM parser), so all
 * extraction works on strings: decode entities, pull attributes, strip tags,
 * absolutise links and normalise the "Artist - Title" shapes that music sites
 * love to use.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  middot: "·",
  laquo: "«",
  raquo: "»",
};

/** Decode the handful of HTML entities that show up in scraped titles. */
export function decodeEntities(text: string): string {
  if (!text) return "";
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Remove tags and collapse whitespace. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Read one attribute out of an attribute blob (`href="x" data-id='1'`). */
export function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = re.exec(attrs);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  return decodeEntities(value).trim() || undefined;
}

/** Resolve a possibly-relative URL against a base, never throwing. */
export function absolutise(base: string, href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(javascript|data|mailto):/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

/** `"3:45"` / `"1:02:03"` / `"225"` / `"3:45 min"` -> seconds. */
export function parseClock(input: string | number | undefined | null): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.round(input) : undefined;
  const text = input.trim().toLowerCase();
  if (!text) return undefined;
  const hms = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (hms) {
    const a = Number(hms[1]);
    const b = Number(hms[2]);
    const c = hms[3] === undefined ? undefined : Number(hms[3]);
    return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const numeric = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes)?$/.exec(text);
  if (numeric) {
    const value = Number(numeric[1]);
    return Math.round(/^m|^min/.test(numeric[2] ?? "") ? value * 60 : value);
  }
  return undefined;
}

/** Font-weight of a title, used to pick the best label from a result row. */
export function cleanText(value: string | undefined): string {
  return decodeEntities(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|·•]+|[\s\-–—|·•]+$/g, "")
    .trim();
}

/**
 * Split the many "Artist - Title" / "Title by Artist" shapes music sites emit.
 *
 *   "Daft Punk - Get Lucky"            -> { artist: "Daft Punk", title: "Get Lucky" }
 *   "Get Lucky — Daft Punk (Official)" -> { title: "Get Lucky", artist: "Daft Punk" }
 *   "Get Lucky"                        -> { title: "Get Lucky" }
 */
export function splitArtistTitle(raw: string, hint: "artist-first" | "title-first" | "auto" = "auto"): {
  title: string;
  artist?: string;
} {
  const text = cleanText(raw)
    .replace(/\s*\((?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visuali[sz]er)\)\s*/gi, " ")
    .replace(/\s*\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?)\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = text.split(/\s+[–—]\s+|\s+-\s+/).map((part) => cleanText(part)).filter(Boolean);
  if (parts.length < 2) return { title: text };

  if (hint === "artist-first") return { artist: parts[0], title: parts.slice(1).join(" - ") };
  if (hint === "title-first") return { title: parts[0], artist: parts.slice(1).join(" - ") };

  // auto: the longer side is almost always the title, except when the first
  // segment ends in a known artist suffix ("- Topic", "VEVO", "Records").
  const [first, ...rest] = parts;
  const second = rest.join(" - ");
  if (/(vevo|- topic|records|official)$/i.test(first)) return { artist: first, title: second };
  return first.length >= second.length ? { title: first, artist: second } : { artist: first, title: second };
}

/** Lowercase, punctuation-free form used for matching and de-duplication. */
export function normalizeForMatch(value: string): string {
  return decodeEntities(value)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(feat|ft|featuring|prod|remaster(ed)?|official|video|audio|lyrics?|hd|hq)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sørensen–Dice coefficient over character trigrams (0..1). */
export function diceSimilarity(a: string, b: string): number {
  const left = normalizeForMatch(a).replace(/\s+/g, " ");
  const right = normalizeForMatch(b).replace(/\s+/g, " ");
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string): Map<string, number> => {
    const padded = `  ${value}  `;
    const map = new Map<string, number>();
    for (let i = 0; i < padded.length - 2; i++) {
      const gram = padded.slice(i, i + 3);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const a1 = grams(left);
  const b1 = grams(right);
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of a1) {
    total += count;
    overlap += Math.min(count, b1.get(gram) ?? 0);
  }
  for (const count of b1.values()) total += count;
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** Token-overlap score that rewards an exact title hit. */
export function titleArtistScore(
  candidate: { title: string; artist?: string },
  target: { title: string; artist?: string },
): number {
  const titleScore = diceSimilarity(candidate.title, target.title);
  const artistScore = candidate.artist && target.artist ? diceSimilarity(candidate.artist, target.artist) : 0.5;
  return titleScore * 0.72 + artistScore * 0.28;
}
