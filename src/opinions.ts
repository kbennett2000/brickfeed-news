/**
 * Opinion generation stage (ADR-0015): derives the day's author set (ADR-0013 rotation
 * pair + ADR-0014 letters-schedule overlay), selects source articles per news persona
 * (topic-gated, bias-weighted), generates one piece per author through the free-form
 * text seam, and publishes each as an OPINION-category manifest record keyed by the
 * idempotency key `opinion-{author}-{YYYY-MM-DD}` (UTC). Each successful piece also
 * derives an image brief (ADR-0016): one extra JSON completion yielding the neutral
 * `imagePrompt` (wrapped with the configured brick style, story-style) and the
 * `caption`, persisted with the piece all-or-nothing so a stored record is always
 * ready for the image stage and the publish gate.
 *
 * Contracts that matter:
 *  - Pure derivation: `authorsFor` is a function of (date, personas) — no state file,
 *    missed days are never backfilled.
 *  - Fail-closed topic gate: ONE batched classification per run; any provider or parse
 *    failure excludes ALL candidates (news authors skip; letters are unaffected).
 *  - Idempotency before providers: an existing key skips the author before any call, so
 *    a rerun with nothing to do costs zero generations (gate included).
 *  - Failure isolation: each author runs in its own try/catch, serially; the result is
 *    `ok: false` only when every derived author FAILED (skips are not failures).
 *
 * All side-effects are injected (`OpinionsDeps`); the manifest is copied, never mutated
 * in place — callers persist the returned manifest (or discard it: dry-run returns the
 * input untouched).
 */
import { wrapBrickStyle } from "./brick.js";
import type { Category } from "./category.js";
import type { Config } from "./config.js";
import { extractJsonObject } from "./generator/parse.js";
import type { TextGenerator } from "./generator/text.js";
import type { OpinionAssets, Persona, Weekday } from "./personas.js";
import { WEEKDAYS } from "./personas.js";
import { isPublishable } from "./publish.js";
import {
  MAX_TITLE_CHARS,
  MAX_TITLE_WORDS,
  letterColumnHasLetter,
  looksLikeLetterAttribution,
  looksLikeMetaNarration,
  looksLikeRefusal,
  recoverLeadingTitleRegion,
  stripTitleDressing,
  stripWrappingFence,
} from "./sanitize.js";
import type { Manifest, ManifestRecord } from "./types.js";

/** ADR-0013 decision 3: fixed pairs, active pair = daysSinceUnixEpoch(UTC) % 3. */
export const ROTATION: readonly (readonly [string, string])[] = [
  ["alice", "bob"],
  ["edgar", "stryker"],
  ["larry", "cynthia"],
];

/**
 * ADR-0027: daily fixtures — `source: news` personas that publish EVERY day, outside the 3-pair
 * ROTATION. `authorsFor` appends these (deduped against the day's pair) so a persona whose whole
 * conceit is a daily beat (Hodge, the sports serf) isn't rationed to once every three days.
 */
export const DAILY_NEWS: readonly string[] = ["hodge"];

/** Selection pool window: stories first seen within this many hours are candidates. */
export const CANDIDATE_WINDOW_HOURS = 24;

/**
 * Grim-day fallback window (ADR-0032 Layer C): when the 24h gate passes ZERO candidates, the
 * pool is re-selected over this wider window and the older delta is gated, before news personas
 * fall through to evergreen. Surfaces lighter stories that aged past 24h on a heavy news day.
 */
export const OPINION_FALLBACK_WINDOW_HOURS = 72;

/**
 * Weight for sections a persona's `selection_bias` doesn't list (bias values are small
 * integers, 1–3 today): unlisted sections stay rare but are never unreachable.
 */
export const FLOOR_WEIGHT = 0.25;

/**
 * Per-persona body word ranges, mirroring the persona PROSE (the spec of record):
 * `_shared.md` sets the 1200–1600 baseline for everyone; a persona's hard rule can override
 * it ("the length is the bit"). Alice runs 1400–2000 (a longer, relentless tirade); Edgar
 * rambles 1600–2500. Every band is reachable now that opinion pieces generate on Sonnet
 * (generator.opinionModel), which follows word counts far better than Haiku did. The `min/2`
 * hard-fail floor is deliberately below the target — it rejects only genuine stubs, not the
 * common shorter rolls, which would otherwise fail the author. Personas without an override
 * (bob, cynthia, hodge, larry, stryker, priscilla, tom) track DEFAULT_LENGTH_RANGE. Tests pin these
 * constants against the committed .md files so the two can't drift silently.
 */
export const DEFAULT_LENGTH_RANGE: readonly [number, number] = [1200, 1600];
export const LENGTH_RANGES: Record<string, readonly [number, number]> = {
  edgar: [1600, 2500],
  alice: [1400, 2000],
};

/**
 * Max in-cycle attempts at generating a usable piece before an author is marked failed.
 * Haiku intermittently emits a malformed piece (missing title/body) or wildly out-of-band
 * length; those are transient, so we retry the whole generate→validate→brief sequence in the
 * SAME cycle instead of waiting for the next 4-hour publish-hour tick to self-heal (ADR-0023).
 * Bounded at 2 (one retry) — each attempt is one Haiku call (~9s), far cheaper than a 4h delay.
 */
export const MAX_PIECE_ATTEMPTS = 4;

/** Caption on a canned fallback column's hero (the persona headshot); brick credit appended downstream. */
export const FALLBACK_CAPTION = "From the columnist's desk.";

/** One classified candidate verdict from the topic gate. */
export interface GateVerdict {
  id: string;
  verdict: "eligible" | "excluded";
  reason: string;
}

export interface OpinionsDeps {
  /** The free-form text seam (createTextGenerator) — pieces AND the incumbent gate/brief calls. */
  generate: TextGenerator;
  now: () => Date;
  /** Uniform [0,1) source for weighted sampling; injected in tests. Default Math.random. */
  rng?: () => number;
  log?: (message: string) => void;
  /**
   * Opt-in TTS local-provider routing (ADR-0022; built by createOpinionTtsDeps). Undefined →
   * the incumbent Claude path (default; byte-identical to today).
   *  - `ttsGate` FAILS CLOSED: null → all candidates excluded (no Claude fallback), a complete
   *    per-id verdict map on success (uncertain/missing/duplicate → excluded).
   *  - `ttsBrief` FAILS OVER: null → the incumbent brief call runs as the fallback.
   */
  ttsGate?: (candidates: ManifestRecord[]) => Promise<Map<string, GateVerdict> | null>;
  ttsBrief?: (
    persona: Persona,
    title: string,
    body: string,
    articles: ManifestRecord[],
  ) => Promise<ImageBrief | null>;
  /**
   * Persona name → a durable, already-stored image URL (the persona's headshot avatar) used as the
   * hero for a CANNED fallback column (ADR-0033 Layer 2a). A canned fallback publishes only when
   * both its committed text (`assets.fallbacks[name]`) AND this image exist, so it needs no
   * image-gen call. Absent → no canned fallback (the author fails as before). Injected by cycle.ts
   * from the headshot manifest.
   */
  fallbackImages?: Record<string, string>;
}

export interface OpinionsOptions {
  /** YYYY-MM-DD (UTC) for derivation + keys; defaults to today. Never shifts the pool window. */
  date?: string;
  /** Explicit author names (bypasses derivation — the CLI's --authors). Unknown names throw. */
  authors?: string[];
  /** Gate + selection only: print-what-would-happen, zero piece calls, manifest untouched. */
  dryRun?: boolean;
}

export type AuthorStatus =
  | "published"
  | "would-publish"
  | "skipped-idempotent"
  | "skipped-no-candidates"
  | "failed";

export interface AuthorOutcome {
  author: string;
  /** The idempotency key (= the manifest record id when published). */
  key: string;
  status: AuthorStatus;
  detail?: string;
  sourceArticleIds?: string[];
  /** True when a news persona published an evergreen (no-source) fallback piece (ADR-0032 D). */
  evergreen?: boolean;
  /** True when the committed CANNED fallback column was published after live generation failed (ADR-0033 2a). */
  fallbackUsed?: boolean;
}

export interface OpinionsResult {
  /** The YYYY-MM-DD (UTC) the run keyed off. */
  date: string;
  authors: AuthorOutcome[];
  /** Gate verdicts for this run's candidate pool; undefined if the gate never ran. */
  gate?: GateVerdict[];
  /** One line describing the topic-gate outcome, for the stage summary (ADR-0018). */
  gateSummary: string;
  manifest: Manifest;
  /** False only when ≥1 author was derived and EVERY outcome is `failed`. */
  ok: boolean;
}

/** Whole UTC days since the Unix epoch — the ADR-0013 rotation index input. */
export function daysSinceUnixEpoch(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

/** The date's UTC weekday as a lowercase schedule token (WEEKDAYS is mon-first). */
export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[(date.getUTCDay() + 6) % 7];
}

/** The date's UTC calendar day as YYYY-MM-DD. */
export function utcDateOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The per-author-per-day idempotency key (ADR-0013 decision 4) — also the record id. */
export function opinionKey(author: string, dateUTC: string): string {
  return `opinion-${author}-${dateUTC}`;
}

/**
 * ADR-0018: the cycle's publish-hour gate — `<` here means `>=` opens it, so a missed
 * publish-hour tick self-heals on the next cycle. Only the CYCLE consults this; direct
 * CLI runs bypass it (manual is deliberate).
 */
export function beforeOpinionPublishHour(now: Date, publishHourUTC: number): boolean {
  return now.getUTCHours() < publishHourUTC;
}

/**
 * The day's author set (pure): the rotation pair (members present in the loaded
 * `source: news` roster, in pair order), then the DAILY_NEWS fixtures (present, `source: news`,
 * deduped against the pair), then every `source: letters` persona whose schedule contains the
 * date's UTC weekday (sorted by name). `dateUTC` is YYYY-MM-DD.
 */
export function authorsFor(dateUTC: string, personas: Persona[]): Persona[] {
  const date = new Date(`${dateUTC}T00:00:00Z`);
  const pair = ROTATION[daysSinceUnixEpoch(date) % 3];
  const weekday = weekdayOf(date);

  const byName = new Map(personas.map((p) => [p.name, p]));
  const news = pair
    .map((name) => byName.get(name))
    .filter((p): p is Persona => p !== undefined && p.source === "news");
  const daily = DAILY_NEWS.filter((name) => !pair.includes(name))
    .map((name) => byName.get(name))
    .filter((p): p is Persona => p !== undefined && p.source === "news");
  const letters = personas
    .filter((p) => p.source === "letters" && (p.schedule ?? []).includes(weekday))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...news, ...daily, ...letters];
}

/**
 * The selection pool: records that are on the site (publishable), not opinion pieces
 * (nor OPINION-categorized), and first seen within the candidate window. Newest-first
 * for a deterministic gate-prompt order.
 */
export function opinionCandidates(
  manifest: Manifest,
  nowMs: number,
  windowHours: number = CANDIDATE_WINDOW_HOURS,
): ManifestRecord[] {
  const windowMs = windowHours * 3600_000;
  return Object.values(manifest.stories)
    .filter((r) => {
      if (!isPublishable(r) || r.category === "OPINION" || r.author) return false;
      const t = new Date(r.firstSeen).getTime();
      return Number.isFinite(t) && nowMs - t <= windowMs;
    })
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
}

/**
 * The topic-gate classification prompt (ADR-0015 decision 3): one batched call, strict
 * JSON out, biased to exclude when uncertain. Titles/summaries are our own rewrites
 * (headline/description), not feed text.
 */
export function buildGatePrompt(candidates: ManifestRecord[]): string {
  const stories = candidates.map((r) => ({
    id: r.id,
    title: r.headline ?? r.title,
    summary: r.description ?? "",
  }));
  return [
    "You are a content classifier for a lighthearted satirical opinion section. For EACH " +
      "story below, decide whether it is eligible as source material for comedic opinion " +
      "writing. Exclude any story that centers a tragedy, violence, death, disaster " +
      "casualties, or victims of crime or abuse — the section must never joke about " +
      "those. If uncertain, exclude.",
    "Output STRICT JSON and nothing else — no prose, no markdown fences — an object with " +
      'EXACTLY this shape: {"verdicts":[{"id":"<story id>","verdict":"eligible" or ' +
      '"excluded","reason":"<one line>"}]} containing exactly one verdict per story.',
    `STORIES:\n${JSON.stringify(stories, null, 2)}`,
  ].join("\n\n");
}

/**
 * Strictly parse the gate's response for exactly the candidate ids that were sent:
 * every id exactly once, verdict exactly "eligible" or "excluded" (reason tolerated
 * missing → ""). Any deviation — unparseable, wrong shape, unknown/duplicate/missing
 * id, bad verdict token — returns null, which the caller treats as ALL EXCLUDED
 * (fail-closed). Never throws.
 */
export function parseGateVerdicts(text: string, ids: string[]): Map<string, GateVerdict> | null {
  const slice = extractJsonObject(text);
  if (slice == null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const verdicts = (parsed as Record<string, unknown>).verdicts;
  if (!Array.isArray(verdicts)) return null;

  const expected = new Set(ids);
  const out = new Map<string, GateVerdict>();
  for (const entry of verdicts) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, verdict, reason } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !expected.has(id) || out.has(id)) return null;
    if (verdict !== "eligible" && verdict !== "excluded") return null;
    out.set(id, { id, verdict, reason: typeof reason === "string" ? reason : "" });
  }
  if (out.size !== expected.size) return null;
  return out;
}

/**
 * Sections that are OWNED by their listed personas (ADR-0032 Layer E): a persona that
 * does NOT explicitly list an owned section never draws it (weight 0), instead of the
 * usual FLOOR_WEIGHT. SPORTS is owned by Hodge — no other columnist covers sports.
 */
export const OWNED_SECTIONS: ReadonlySet<Category> = new Set<Category>(["SPORTS"]);

/**
 * Sample up to `k` records without replacement, weighting each by the persona's bias
 * for its section. Weighting rules (ADR-0032):
 *  - a section listed in `bias` uses that weight;
 *  - an unlisted section gets FLOOR_WEIGHT (rare, never zero) — UNLESS it is an OWNED
 *    section (weight 0, never drawn by a non-owner) or `exclusive` is set (weight 0, the
 *    persona writes only its listed sections).
 * Zero-weight candidates are dropped up front, so if nothing is positively weighted the
 * result is empty (the caller then falls back to an evergreen piece). `rng` is a uniform
 * [0,1) source; cumulative-weight walk per draw.
 */
export function weightedSample(
  candidates: ManifestRecord[],
  bias: Partial<Record<Category, number>>,
  k: number,
  rng: () => number,
  exclusive = false,
): ManifestRecord[] {
  const weightOf = (r: ManifestRecord): number => {
    const cat = r.category;
    if (cat !== undefined && bias[cat] !== undefined) return bias[cat] as number;
    if (exclusive) return 0; // exclusive persona: only explicitly-listed sections
    if (cat !== undefined && OWNED_SECTIONS.has(cat)) return 0; // owned section, non-owner
    return FLOOR_WEIGHT;
  };
  // Drop zero-weight candidates so every remaining draw is positively weighted (no
  // FP-edge fallback can ever select a section this persona must not write).
  const remaining = candidates.filter((r) => weightOf(r) > 0);
  const picked: ManifestRecord[] = [];

  while (picked.length < k && remaining.length > 0) {
    const total = remaining.reduce((sum, r) => sum + weightOf(r), 0);
    let roll = rng() * total;
    let index = remaining.length - 1; // fallback for FP edge (roll ≈ total)
    for (let i = 0; i < remaining.length; i++) {
      roll -= weightOf(remaining[i]);
      if (roll < 0) {
        index = i;
        break;
      }
    }
    picked.push(remaining[index]);
    remaining.splice(index, 1);
  }
  return picked;
}

/** The persona's sanctioned body word range (spec'd in the persona prose; see constants). */
export function lengthRangeFor(persona: Persona): readonly [number, number] {
  return LENGTH_RANGES[persona.name] ?? DEFAULT_LENGTH_RANGE;
}

/**
 * Assemble the generation prompt, mirroring the bench (scripts/persona-bench.ts):
 * news = shared + voice + articles + task; letters = shared + letters rules + voice +
 * task. Both demand a first-line title so the output maps onto headline/description.
 */
export function buildOpinionPrompt(
  assets: OpinionAssets,
  persona: Persona,
  articles: ManifestRecord[],
): string {
  const [min, max] = lengthRangeFor(persona);
  const titleRule =
    "First line: a short original title for your piece. Then a blank line, then the " +
    "piece itself. Output only the title and the piece - no preamble, no commentary.";

  if (persona.source === "letters") {
    return [
      assets.shared.trim(),
      assets.letters.trim(),
      persona.body,
      `Write one ${min}-${max} word reader-letter column: invent the letter per your ` +
        `instructions above, open with it in your column's format, then answer it in your ` +
        `voice. ${titleRule} The title is a real column title about the topic — NEVER the ` +
        `letter-writer's name and city (that belongs inside the column, not in the title line).`,
    ].join("\n\n");
  }

  // Evergreen fallback (ADR-0032 Layer D): a news persona with no eligible source story
  // still publishes — a timeless, no-source column in its voice. The `_evergreen.md` block
  // overrides the shared "react only to the articles" rule.
  if (articles.length === 0) {
    return [
      assets.shared.trim(),
      assets.evergreen.trim(),
      persona.body,
      `Write one ${min}-${max} word evergreen column per the instructions above — no source ` +
        `story today. ${titleRule}`,
    ].join("\n\n");
  }

  const blocks = articles.map((r, i) => {
    const lines = [r.headline ?? r.title];
    if (r.description) lines.push(r.description);
    if (r.sourceName) lines.push(`(via ${r.sourceName}: ${r.title})`);
    return `ARTICLE ${i + 1}:\n${lines.join("\n")}`;
  });
  return [
    assets.shared.trim(),
    persona.body,
    blocks.join("\n\n"),
    `Write one ${min}-${max} word opinion piece reacting to ONE of the articles above. ` +
      titleRule,
  ].join("\n\n");
}

/**
 * Split a completion into its title line and body per the output contract (first line =
 * title, rest = body). Before splitting it defends against the ways a model ignores the
 * "no preamble" rule (src/sanitize.ts): a whole-completion code fence is unwrapped, an
 * outright refusal fails closed (null), and leaked preamble/delimiter/label lines are
 * skipped so the REAL title is recovered (the Priscilla "Wisdom's Moat" leak). Then the
 * usual markdown dressing (heading markers, wrapping emphasis/quotes) is stripped and a
 * title-length bound rejects a paragraph masquerading as a title. Null when either part
 * is empty or the title is implausibly long — the caller fails that author rather than
 * storing a half or garbled piece.
 */
export function splitTitleBody(
  text: string,
  isLetterColumn = false,
): { title: string; body: string } | null {
  const unfenced = stripWrappingFence(text);
  if (looksLikeRefusal(unfenced)) return null;
  const trimmed = recoverLeadingTitleRegion(unfenced);
  const newline = trimmed.indexOf("\n");
  if (newline < 0) return null;
  const title = stripTitleDressing(trimmed.slice(0, newline));
  const body = trimmed.slice(newline + 1).trim();
  if (title.length === 0 || body.length === 0) return null;
  if (title.length > MAX_TITLE_CHARS || wordCount(title) > MAX_TITLE_WORDS) return null;
  // Fail-closed backstop: if recovery could not salvage a clean title and the title line is still
  // a meta-narration sentence ("I'll write one reader-letter column ... now."), drop the piece
  // rather than publish the preamble. The author self-heals on the next cycle.
  if (looksLikeMetaNarration(title)) return null;
  // Letter-column backstop (ADR-0031): a letter persona sometimes leads with the invented
  // letter-writer's attribution ("Wanda from Flagstaff, Arizona") as the title instead of a real
  // column title. It is short and clean, so no other guard catches it — reject it here so the
  // author re-rolls a proper headline this cycle.
  if (isLetterColumn && looksLikeLetterAttribution(title)) return null;
  return { title, body };
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** The image brief a successful piece derives (ADR-0016 decision 1). */
export interface ImageBrief {
  /** Neutral visual scene in the story convention — brick styling is added downstream. */
  imagePrompt: string;
  /** One short photo-caption line; the figure template appends the studio credit. */
  caption: string;
}

/**
 * The image-brief prompt (ADR-0016 decision 1): one single-purpose completion per
 * published piece asking for the standard neutral scene + a caption, as strict JSON.
 * The hard rules mirror the story generation contract (src/prompt.ts): purely visual,
 * no text or brands, a real photographed scene — never pre-stylized, never the author,
 * and never a named real individual (ADR-0024): Grok's image skill refuses from-scratch
 * likenesses of named people, so any real name in the scene fails to image entirely.
 * The subject comes from the piece's topic: the reacted-to articles for news personas,
 * the invented letter's situation for letters personas.
 */
export function buildImageBriefPrompt(
  persona: Persona,
  title: string,
  body: string,
  articles: ManifestRecord[],
): string {
  const subject =
    persona.source === "letters"
      ? "the everyday situation described in the reader letter the piece answers"
      : articles.length === 0
        ? "the ordinary, everyday subject the piece is about"
        : "the news story the piece reacts to (see the source articles below)";
  const articleBlocks =
    articles.length === 0
      ? ""
      : "\n\nSOURCE ARTICLES the piece reacts to:\n" +
        articles
          .map((r, i) => {
            const lines = [r.headline ?? r.title];
            if (r.description) lines.push(r.description);
            return `ARTICLE ${i + 1}:\n${lines.join("\n")}`;
          })
          .join("\n\n");
  return [
    "You write an image brief for a satirical opinion piece on a static news site. " +
      "Given the piece below, produce TWO things:",
    '1. "imagePrompt": a SHORT scene - roughly 15 to 30 words - that is playful, ' +
      "exaggerated, and cartoonish, and PURELY VISUAL, depicting " +
      subject +
      " - never the author, and never the act of writing or publishing. Hard rules: " +
      "NO text, letters, numbers, signs, logos, speech bubbles, or written words of any " +
      "kind anywhere in the scene. NO brand names, trademarks, company names, or product " +
      "names. Describe it as a real, physical scene as if photographed. Do NOT stylize " +
      "it as a miniature model, a plastic figurine, a sculpture, or an assembled-block " +
      "build - that styling is added later, downstream, not by you. NO real, " +
      "identifiable people: never name or depict a specific real individual (politician, " +
      "official, celebrity, or private person). Refer to any person ONLY by a generic role " +
      "or appearance - \"a former mayor\", \"a government official\" - never a real name. " +
      "This scene is our own generic art, never a real person's likeness.",
    '2. "caption": ONE short line - roughly 8 to 15 words - describing that same scene ' +
      "as a wry photo caption. Same hard rules; do NOT append any credit, byline, or " +
      "attribution (added later, downstream).",
    "Output STRICT JSON and nothing else - no prose, no markdown fences - an object " +
      'with EXACTLY these keys: {"imagePrompt":"...","caption":"..."}.',
    `OPINION PIECE:\nTitle: ${title}\n\n${body}${articleBlocks}`,
  ].join("\n\n");
}

/**
 * Strictly parse the image-brief response: both keys present as non-empty strings.
 * Any deviation returns null — the caller fails that author and stores nothing
 * (ADR-0016 decision 2: a stored opinion record always has its brief). Never throws.
 */
export function parseImageBrief(text: string): ImageBrief | null {
  const slice = extractJsonObject(text);
  if (slice == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { imagePrompt, caption } = parsed as Record<string, unknown>;
  if (typeof imagePrompt !== "string" || imagePrompt.trim().length === 0) return null;
  if (typeof caption !== "string" || caption.trim().length === 0) return null;
  return { imagePrompt: imagePrompt.trim(), caption: caption.trim() };
}

/**
 * Run the opinion stage for one day: derive (or accept) the author set, skip already-
 * published keys, gate + select for news personas, generate serially (piece + image
 * brief, all-or-nothing), and insert the published records into a COPY of the manifest.
 * `config` supplies `brickStyle.styleLanguage` for the brief's wrap (ADR-0016). See the
 * module doc for the contracts; see OpinionsOptions for dry-run semantics. Throws only
 * on a caller error (an unknown name in opts.authors); provider and per-author failures
 * are contained.
 */
export async function runOpinions(
  config: Config,
  startingManifest: Manifest,
  assets: OpinionAssets,
  deps: OpinionsDeps,
  opts: OpinionsOptions = {},
): Promise<OpinionsResult> {
  const log = deps.log ?? (() => {});
  const rng = deps.rng ?? Math.random;
  const dryRun = opts.dryRun ?? false;
  const date = opts.date ?? utcDateOf(deps.now());

  const manifest: Manifest = dryRun
    ? startingManifest
    : { version: startingManifest.version, stories: { ...startingManifest.stories } };

  // Author set: explicit --authors (strict: a typo'd name must not silently no-op) or
  // the pure daily derivation.
  let derived: Persona[];
  if (opts.authors) {
    const byName = new Map(assets.personas.map((p) => [p.name, p]));
    derived = opts.authors.map((name) => {
      const persona = byName.get(name);
      if (!persona) throw new Error(`unknown persona "${name}"`);
      return persona;
    });
  } else {
    derived = authorsFor(date, assets.personas);
  }
  log(`opinions ${date}: authors — ${derived.map((p) => p.name).join(", ") || "(none)"}`);

  const outcomes: AuthorOutcome[] = [];

  // Idempotency BEFORE any provider call (ADR-0015 decision 6): a rerun that has nothing
  // left to publish must cost zero generations, gate included.
  const remaining: Persona[] = [];
  for (const persona of derived) {
    const key = opinionKey(persona.name, date);
    if (manifest.stories[key]) {
      outcomes.push({ author: persona.name, key, status: "skipped-idempotent" });
      log(`opinions: ${persona.name} skipped — ${key} already published`);
    } else {
      remaining.push(persona);
    }
  }

  // Topic gate: one batched classification shared by every news author this run
  // (fail-closed — any provider/parse failure empties the eligible pool).
  let gate: GateVerdict[] | undefined;
  let eligible: ManifestRecord[] = [];
  let gateFailed = false;
  let gateSummary = "gate not run";
  if (remaining.some((p) => p.source === "news")) {
    let gateVia = deps.ttsGate ? "TTS" : "Claude";

    // Run the TTS→Claude failover gate over an arbitrary candidate list; null = failed closed.
    // Opt-in TTS gate (ADR-0022): when TTS is unavailable it FAILS OVER to the Claude gate
    // (owner directive 2026-07-14) rather than fail-closed, so a TTS flap doesn't silently starve
    // news opinions. Only when BOTH the TTS gate and the Claude fallback fail do we fail closed.
    const gatePool = async (cands: ManifestRecord[]): Promise<Map<string, GateVerdict> | null> => {
      const claudeGate = async (): Promise<Map<string, GateVerdict> | null> => {
        let response: string | null = null;
        try {
          response = await deps.generate(buildGatePrompt(cands));
        } catch {
          response = null;
        }
        return response == null ? null : parseGateVerdicts(response, cands.map((r) => r.id));
      };
      if (deps.ttsGate) {
        let v: Map<string, GateVerdict> | null;
        try {
          v = await deps.ttsGate(cands);
        } catch {
          v = null;
        }
        if (v == null) {
          gateVia = "Claude (TTS failover)";
          log("opinions: opinion-gate TTS unavailable → failing over to the Claude gate");
          return claudeGate();
        }
        return v;
      }
      return claudeGate();
    };

    // Gate one pool, folding verdicts into `eligible`/`verdictList` and logging per-verdict.
    // Returns false (and sets gateFailed) if the gate failed closed for this pool.
    const gatedIds = new Set<string>();
    const verdictList: GateVerdict[] = [];
    const gateAndFold = async (cands: ManifestRecord[]): Promise<boolean> => {
      const verdicts = await gatePool(cands);
      if (verdicts == null) {
        gateFailed = true;
        gateSummary = `gate failed closed (${cands.length} candidate(s) excluded)`;
        log(
          `opinions: TOPIC GATE FAILED CLOSED — all ${cands.length} candidate(s) ` +
            "excluded this run (both TTS and Claude gate unavailable, or malformed verdict JSON)",
        );
        return false;
      }
      for (const r of cands) {
        const v = verdicts.get(r.id) as GateVerdict;
        gatedIds.add(r.id);
        verdictList.push(v);
        log(`opinions: gate ${v.verdict} ${r.id}${v.reason ? ` — ${v.reason}` : ""}`);
        if (v.verdict === "eligible") eligible.push(r);
      }
      return true;
    };

    const primary = opinionCandidates(manifest, deps.now().getTime());
    if (primary.length > 0) await gateAndFold(primary);

    // Layer C (ADR-0032): the 24h pool passed nothing (or was empty) and the gate did not fail —
    // widen to the fallback window and gate only the older delta before news personas fall back
    // to evergreen. A grim news day can bury the lighter, gate-passable stories just past 24h.
    if (!gateFailed && eligible.length === 0) {
      const wide = opinionCandidates(
        manifest,
        deps.now().getTime(),
        OPINION_FALLBACK_WINDOW_HOURS,
      );
      const delta = wide.filter((r) => !gatedIds.has(r.id));
      if (delta.length > 0) {
        log(
          `opinions: 0 eligible in ${CANDIDATE_WINDOW_HOURS}h → widening to ` +
            `${OPINION_FALLBACK_WINDOW_HOURS}h (${delta.length} older candidate(s))`,
        );
        await gateAndFold(delta);
      }
    }

    if (!gateFailed) {
      if (gatedIds.size > 0) {
        gate = verdictList;
        gateSummary = `gate passed ${eligible.length}/${verdictList.length} candidate(s) via ${gateVia}`;
        log(`opinions: ${gateSummary}`);
      } else {
        gateSummary = "gate not run (no candidates)";
        log(`opinions: no candidate stories in the last ${OPINION_FALLBACK_WINDOW_HOURS}h`);
      }
    }
  }

  // Per-author, serially (the subscription CLIs behave badly in parallel), each isolated:
  // a throw or failed generation marks THAT author failed and the loop continues.
  for (const persona of remaining) {
    const key = opinionKey(persona.name, date);
    try {
      let picks: ManifestRecord[] = [];
      // A news persona with no eligible pick does NOT skip — it publishes an evergreen
      // (no-source) column so every scheduled columnist still runs (ADR-0032 Layer D). An
      // evergreen piece needs no gate: with no source story it cannot satirize a tragedy.
      let evergreen = false;
      if (persona.source === "news") {
        picks = weightedSample(
          eligible,
          persona.selectionBias,
          3,
          rng,
          persona.sectionsExclusive ?? false,
        );
        if (picks.length === 0) {
          evergreen = true;
          const reason = gateFailed
            ? "topic gate failed closed"
            : "no eligible candidates after the topic gate";
          log(`opinions: ${persona.name} → evergreen fallback (${reason})`);
        } else {
          log(`opinions: ${persona.name} selected ${picks.map((r) => r.id).join(", ")}`);
        }
      }
      // News personas pass their picks; letters and evergreen pass no articles (picks === []).
      const hasSource = persona.source === "news" && picks.length > 0;

      if (dryRun) {
        outcomes.push({
          author: persona.name,
          key,
          status: "would-publish",
          ...(hasSource ? { sourceArticleIds: picks.map((r) => r.id) } : undefined),
          ...(evergreen ? { evergreen: true } : undefined),
        });
        log(
          `opinions (dry-run): ${persona.name} would publish ${key}` +
            (evergreen ? " (evergreen)" : ""),
        );
        continue;
      }

      // Generate → validate → derive brief, retried in-cycle up to MAX_PIECE_ATTEMPTS (ADR-0023).
      // The transient failure modes below (null piece, missing title/body, out-of-band length,
      // brief derivation) are re-rolled by regenerating the piece THIS cycle rather than deferring
      // to the next 4-hour tick. Only when every attempt is exhausted is the author marked failed.
      let published = false;
      let lastDetail = "";
      for (let attempt = 1; attempt <= MAX_PIECE_ATTEMPTS && !published; attempt++) {
        const note = (detail: string) => {
          lastDetail = detail;
          const more = attempt < MAX_PIECE_ATTEMPTS;
          log(
            `opinions: ${persona.name} attempt ${attempt}/${MAX_PIECE_ATTEMPTS} failed — ${detail}` +
              (more ? "; retrying" : ""),
          );
        };

        let piece: string | null = null;
        try {
          piece = await deps.generate(buildOpinionPrompt(assets, persona, picks));
        } catch {
          piece = null;
        }
        if (piece == null) {
          note("generation returned null");
          continue;
        }

        const split = splitTitleBody(piece, persona.source === "letters");
        if (split == null) {
          note("output missing title line or body");
          continue;
        }

        // Letter columns MUST reproduce the reader's letter before answering it (ADR-0031). Haiku
        // sometimes drops it and opens straight on the response ("A lovely question, Wanda…"), so
        // the published column never shows the question. Fail closed → re-roll this cycle.
        if (persona.source === "letters" && !letterColumnHasLetter(split.body, persona.displayName)) {
          note("letter column is missing the reader's letter");
          continue;
        }

        // Length sanity per the persona's spec: wildly out of band (>2x) fails the author;
        // merely out of range is a warning — voice beats word count. For a no-source EVERGREEN
        // fallback (ADR-0033 2b) the band is warn-only: on a degraded day we prefer a slightly
        // short/long evergreen column to failing the author into the canned last resort.
        const [min, max] = lengthRangeFor(persona);
        const words = wordCount(split.body);
        if (!evergreen && (words < min / 2 || words > max * 2)) {
          note(`body is ${words} words — out of band for ${min}-${max}`);
          continue;
        }
        if (words < min || words > max) {
          log(`opinions: ${persona.name} length warning — ${words} words (range ${min}-${max})`);
        }

        // Image brief (ADR-0016): derive the hero prompt + caption for the finished piece.
        // All-or-nothing with the piece itself — a failed brief stores NO record, so the
        // idempotency key stays free and the next attempt/run retries the whole author.
        let brief: ImageBrief | null = null;
        // Opt-in TTS brief (ADR-0022) FAILS OVER: on any TTS failure it returns null and the
        // incumbent brief call below runs as the transparent fallback (also the default path).
        if (deps.ttsBrief) {
          try {
            brief = await deps.ttsBrief(persona, split.title, split.body, picks);
          } catch {
            brief = null;
          }
        }
        if (brief == null) {
          try {
            const raw = await deps.generate(
              buildImageBriefPrompt(persona, split.title, split.body, picks),
            );
            brief = raw == null ? null : parseImageBrief(raw);
          } catch {
            brief = null;
          }
        }
        if (brief == null) {
          note("image brief derivation failed");
          continue;
        }

        const nowIso = deps.now().toISOString();
        const record: ManifestRecord = {
          id: key,
          url: "",
          title: split.title,
          sourceName: "",
          firstSeen: nowIso,
          lastSeen: nowIso,
          headline: split.title,
          description: split.body,
          imagePrompt: brief.imagePrompt,
          wrappedPrompt: wrapBrickStyle(brief.imagePrompt, config.brickStyle.styleLanguage),
          caption: brief.caption,
          category: "OPINION",
          author: persona.name,
          ...(persona.source === "letters" ? { columnTitle: persona.columnTitle } : undefined),
          ...(hasSource ? { sourceArticleIds: picks.map((r) => r.id) } : undefined),
        };
        manifest.stories[key] = record;
        outcomes.push({
          author: persona.name,
          key,
          status: "published",
          ...(hasSource ? { sourceArticleIds: picks.map((r) => r.id) } : undefined),
          ...(evergreen ? { evergreen: true } : undefined),
        });
        log(
          `opinions: ${persona.name} published ${key} (${words} words)` +
            (evergreen ? " (evergreen)" : ""),
        );
        published = true;
      }
      if (!published) {
        // Model-independent LAST RESORT (ADR-0033 2a): every live attempt failed (a degraded
        // backend), so publish this persona's committed canned column with its headshot avatar as
        // the hero — no model or image-gen call. This is the real never-empty guarantee; only when
        // no canned text OR no fallback image exists does the author actually fail.
        const canned = assets.fallbacks[persona.name];
        const fallbackImage = deps.fallbackImages?.[persona.name];
        if (canned && fallbackImage) {
          const nowIso = deps.now().toISOString();
          manifest.stories[key] = {
            id: key,
            url: "",
            title: canned.title,
            sourceName: "",
            firstSeen: nowIso,
            lastSeen: nowIso,
            headline: canned.title,
            description: canned.body,
            caption: FALLBACK_CAPTION,
            category: "OPINION",
            author: persona.name,
            imageUrl: fallbackImage,
            imageStoredAt: nowIso,
            ...(persona.source === "letters" ? { columnTitle: persona.columnTitle } : undefined),
          };
          outcomes.push({ author: persona.name, key, status: "published", fallbackUsed: true });
          log(
            `opinions: ${persona.name} published ${key} via CANNED FALLBACK — live generation ` +
              `failed all ${MAX_PIECE_ATTEMPTS} attempts (${lastDetail})`,
          );
        } else {
          outcomes.push({ author: persona.name, key, status: "failed", detail: lastDetail });
          log(
            `opinions: ${persona.name} FAILED — ${lastDetail} (${MAX_PIECE_ATTEMPTS} attempts; ` +
              `no canned fallback ${canned ? "image" : "text"})`,
          );
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcomes.push({ author: persona.name, key, status: "failed", detail });
      log(`opinions: ${persona.name} FAILED — ${detail}`);
    }
  }

  const ok = !(derived.length > 0 && outcomes.every((o) => o.status === "failed"));
  return { date, authors: outcomes, gate, gateSummary, manifest, ok };
}

/** One-line stage summary for the cycle CLI output. */
export function summarizeOpinions(result: OpinionsResult): string {
  const count = (s: AuthorStatus) => result.authors.filter((o) => o.status === s).length;
  const skipped = count("skipped-idempotent") + count("skipped-no-candidates");
  const evergreen = result.authors.filter((o) => o.status === "published" && o.evergreen).length;
  const canned = result.authors.filter((o) => o.status === "published" && o.fallbackUsed).length;
  const notes = [
    evergreen > 0 ? `${evergreen} evergreen` : "",
    canned > 0 ? `${canned} canned-fallback` : "",
  ].filter(Boolean);
  const note = notes.length ? ` (${notes.join(", ")})` : "";
  return `${count("published")} published${note}, ${skipped} skipped, ${count("failed")} failed; ${result.gateSummary}`;
}

/**
 * The cycle stage's structured health record (ADR-0018): per-author keys bucketed by
 * outcome plus the gate summary, logged as one JSON line per cycle. Authors skipped
 * for lack of candidates appear in no bucket by design — `gateSummary` explains them.
 */
export interface OpinionsStageOutcome {
  status: "ran" | "skipped-hour";
  published: string[];
  skippedIdempotent: string[];
  failed: string[];
  gateSummary: string;
}

/** Fold an OpinionsResult into the stage outcome the cycle logs (status "ran"). */
export function opinionsStageOutcome(result: OpinionsResult): OpinionsStageOutcome {
  const keys = (s: AuthorStatus) =>
    result.authors.filter((o) => o.status === s).map((o) => o.key);
  return {
    status: "ran",
    published: keys("published"),
    skippedIdempotent: keys("skipped-idempotent"),
    failed: keys("failed"),
    gateSummary: result.gateSummary,
  };
}

/**
 * ADR-0018: newest-OPINION age beyond this is a fault, not weather — the letters
 * schedules cover all seven days and the topic gate never applies to letters, so
 * ≥1 piece/day is the healthy floor even on an all-tragedy news day.
 */
export const OPINION_STALE_THRESHOLD_HOURS = 36;

export interface OpinionStaleness {
  stale: boolean;
  /** How many OPINION records the manifest holds; 0 is itself stale. */
  count: number;
  /** Whole hours since the newest OPINION record's lastSeen; undefined when count is 0. */
  ageHours?: number;
  /** The newest OPINION record's id; undefined when count is 0. */
  newestKey?: string;
}

/** Pure staleness probe over the manifest — the cycle runs it EVERY cycle (ADR-0018). */
export function opinionStaleness(manifest: Manifest, now: Date): OpinionStaleness {
  const records = Object.values(manifest.stories).filter((r) => r.category === "OPINION");
  if (records.length === 0) return { stale: true, count: 0 };
  const newest = records.reduce((a, b) => (a.lastSeen >= b.lastSeen ? a : b));
  const ageHours = Math.floor((now.getTime() - new Date(newest.lastSeen).getTime()) / 3600_000);
  return {
    stale: ageHours > OPINION_STALE_THRESHOLD_HOURS,
    count: records.length,
    ageHours,
    newestKey: newest.id,
  };
}
