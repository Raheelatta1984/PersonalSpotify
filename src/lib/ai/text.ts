/** Text plumbing for the AI layer: normalisation, stemming-lite, fuzzy matching. */

export const STOPWORDS = new Set(
  `a an the and or but if then than that this these those i me my we our you your it its of in on at to for from with without about into over under again more most some any all both each few other such no nor not only own same so too very can will just don should now please play put on find me some something anything songs song music track tracks tune tunes stuff thing things like want need give show listen listening hear hearing to for by as is are was were be been being do does did doing have has had having what which who whom when where why how also really very much too get got make made let lets us go goes`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words that carry search intent but are not part of the musical vocabulary. */
export const FILLER_WORDS = new Set([
  "play", "playing", "played", "find", "search", "look", "looking", "show", "shuffle", "queue",
  "please", "hey", "ok", "okay", "something", "anything", "stuff", "kind", "sort", "type",
  "recommend", "suggest", "recommendation", "recommendations", "create", "make", "build",
  "playlist", "mix", "list", "songwriter", "artist", "band", "album", "track",
]);

/**
 * Domain synonym map. Keys are canonical concepts; values are surface forms the
 * user may type. Applied in both directions by the indexer and query expander.
 */
export const SYNONYMS: Record<string, string[]> = {
  lofi: ["lo-fi", "lofi", "lowfi", "chillhop", "beat tape", "dusty", "vinyl", "crackle"],
  chill: ["chill", "relax", "relaxing", "mellow", "laid back", "laid-back", "easy", "soft", "calm", "peaceful", "cosy", "cozy"],
  focus: ["focus", "concentrate", "concentration", "study", "studying", "homework", "deep work", "productive", "productivity", "coding", "work", "revision", "reading"],
  sleep: ["sleep", "sleeping", "bedtime", "lullaby", "insomnia", "dream", "dreams", "dreamy", "night", "nighttime"],
  energetic: ["energetic", "energy", "hype", "pump", "pumping", "workout", "gym", "running", "run", "sprint", "cardio", "fast", "banger", "party", "dance", "dancing"],
  sad: ["sad", "melancholy", "melancholic", "sorrow", "cry", "crying", "heartbreak", "breakup", "lonely", "blue", "tearful", "mournful"],
  happy: ["happy", "joy", "joyful", "cheerful", "bright", "sunny", "uplifting", "feel good", "feel-good", "upbeat", "smile", "positive"],
  romantic: ["romantic", "romance", "love", "loved", "lovers", "date", "dating", "valentine", "cuddle", "intimate", "wedding"],
  dark: ["dark", "moody", "sinister", "eerie", "tense", "tension", "noir", "thriller", "creepy", "haunting", "brooding"],
  nostalgic: ["nostalgic", "nostalgia", "retro", "memories", "memory", "childhood", "throwback", "vintage", "old school", "old-school", "2000s", "90s", "80s"],
  drive: ["drive", "driving", "road", "roadtrip", "road trip", "highway", "motorway", "car", "cruise", "cruising", "commute"],
  rain: ["rain", "rainy", "storm", "stormy", "wet", "drizzle", "thunder", "overcast"],
  summer: ["summer", "sunshine", "sunny", "beach", "surf", "holiday", "vacation", "pool"],
  winter: ["winter", "cold", "snow", "frost", "glacier", "ice", "arctic"],
  gym: ["gym", "workout", "training", "weights", "lifting", "exercise", "sweat"],
  jazz: ["jazz", "swing", "bebop", "smoky", "cocktail", "speakeasy", "lounge"],
  classical: ["classical", "neoclassical", "piano", "strings", "orchestral", "instrumental piano", "chamber"],
  house: ["house", "deep house", "club", "clubbing", "groove", "four to the floor", "disco"],
  synthwave: ["synthwave", "synth", "retrowave", "outrun", "arp", "arpeggio", "analog", "80s synth"],
  ambient: ["ambient", "drone", "atmospheric", "texture", "soundscape", "meditation", "meditate", "spa", "yoga", "breathing"],
  folk: ["folk", "acoustic", "guitar", "fingerpicked", "fingerpicking", "campfire", "singer songwriter", "singer-songwriter"],
  rock: ["rock", "guitars", "anthem", "anthemic", "stadium", "indie rock"],
  pop: ["pop", "hook", "hooks", "catchy", "chart", "radio", "singalong"],
  hiphop: ["hip hop", "hip-hop", "rap", "beats", "boom bap", "boom-bap", "sample", "sampled"],
  electronic: ["electronic", "electronica", "synth", "edm", "glitch", "idm", "modular"],
  cinematic: ["cinematic", "film", "movie", "score", "soundtrack", "trailer", "epic"],
  instrumental: ["instrumental", "no vocals", "without vocals", "vocal-free", "vocals-free"],
  vocal: ["vocal", "vocals", "singer", "singing", "lyrics", "voice"],
  slow: ["slow", "downtempo", "ballad", "gentle", "quiet", "soft"],
  fast: ["fast", "uptempo", "quick", "high tempo", "driving beat"],
  morning: ["morning", "sunrise", "breakfast", "wake up", "wakeup", "dawn"],
  evening: ["evening", "sunset", "dusk", "after work", "dinner"],
  bollywood: [
    "bollywood", "bwood", "hindi", "filmi", "film song", "film songs", "filmy", "indian", "desi",
    "item song", "item number", "sangeet", "shaadi", "mehndi", "baraat", "hero heroine", "masala",
  ],
  sufi: ["sufi", "ghazal", "qawwali", "devotional", "ruhani", "mystic", "bhairavi", "raga"],
};

/** Reverse lookup: surface form -> canonical concepts. */
export const SURFACE_TO_CONCEPTS = new Map<string, string[]>();
for (const [concept, forms] of Object.entries(SYNONYMS)) {
  for (const raw of [concept, ...forms]) {
    const form = normaliseToken(raw);
    const existing = SURFACE_TO_CONCEPTS.get(form) ?? [];
    if (!existing.includes(concept)) existing.push(concept);
    SURFACE_TO_CONCEPTS.set(form, existing);
  }
}

export function normaliseToken(token: string): string {
  return token
    .toLowerCase()
    // fold Latin accents ("Ólafur" -> "olafur") without touching Devanagari
    // matras, which live outside the U+0300–U+036F combining block.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/-/g, "-")
    // `\p{L}` keeps Devanagari (and every other script) searchable, not just Latin.
    .replace(/[^\p{L}\p{N}\-]/gu, "")
    .trim();
}

export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  if (!text) return [];
  const cleaned = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    // keep letters/numbers from any script so Hindi titles are searchable
    .replace(/[^\p{L}\p{N}\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const raw = cleaned.split(" ").filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    const norm = normaliseToken(t);
    if (!norm) continue;
    if (!opts.keepStopwords && STOPWORDS.has(norm)) continue;
    out.push(stem(norm));
  }
  return out;
}

/** Light Porter-ish stemmer: enough to align "studying"/"study", "beats"/"beat". */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  const irregular: Record<string, string> = {
    studied: "study", studying: "study", studies: "study",
    running: "run", ran: "run", dancing: "dance", danced: "dance",
    crying: "cry", cried: "cry", driving: "drive", drivingmusic: "drive",
    lonely: "lonely", feeling: "feel", feels: "feel",
    relaxing: "relax", relaxed: "relax", sleeping: "sleep", slept: "sleep",
    cooking: "cook", partying: "party", workout: "workout",
  };
  if (irregular[w]) return irregular[w];
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("es") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Character trigrams — the backbone of fuzzy toleration of typos. */
export function trigrams(word: string): string[] {
  const padded = `^${word}$`;
  const out: string[] = [];
  for (let i = 0; i < padded.length - 2; i++) out.push(padded.slice(i, i + 3));
  return out.length ? out : [padded];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity in [0,1] tolerant of typos: 1 - normalised edit distance. */
export function fuzzyScore(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return Math.max(0, 1 - levenshtein(a, b) / max);
}

export function diceCoefficient(a: string, b: string): number {
  const A = new Set(trigrams(a));
  const B = new Set(trigrams(b));
  let overlap = 0;
  for (const g of A) if (B.has(g)) overlap++;
  return (2 * overlap) / (A.size + B.size || 1);
}

/** Strip trailing intent verbs so "play something calm" -> "something calm". */
export function stripInstructions(query: string): string {
  return query
    .replace(/\b(play|find|search|show|give|put on|queue|shuffle|recommend|suggest)\b/gi, " ")
    .replace(/\b(me|us|some|something|anything|for|please|a|an|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
