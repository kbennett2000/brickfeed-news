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

/** Selection pool window: stories first seen within this many hours are candidates. */
export const CANDIDATE_WINDOW_HOURS = 24;

/**
 * Weight for sections a persona's `selection_bias` doesn't list (bias values are small
 * integers, 1–3 today): unlisted sections stay rare but are never unreachable.
 */
export const FLOOR_WEIGHT = 0.25;

/**
 * Per-persona body word ranges, mirroring the persona PROSE (the spec of record):
 * `_shared.md` sets 300–500 for everyone; Tom's hard rule overrides to 500–700 ("the
 * length is the bit"). Tests pin these constants against the committed .md files so the
 * two can't drift silently.
 */
export const DEFAULT_LENGTH_RANGE: readonly [number, number] = [300, 500];
export const LENGTH_RANGES: Record<string, readonly [number, number]> = {
  tom: [500, 700],
};

/**
 * Max in-cycle attempts at generating a usable piece before an author is marked failed.
 * Haiku intermittently emits a malformed piece (missing title/body) or wildly out-of-band
 * length; those are transient, so we retry the whole generate→validate→brief sequence in the
 * SAME cycle instead of waiting for the next 4-hour publish-hour tick to self-heal (ADR-0023).
 * Bounded at 2 (one retry) — each attempt is one Haiku call (~9s), far cheaper than a 4h delay.
 */
export const MAX_PIECE_ATTEMPTS = 2;

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
 * `source: news` roster, in pair order) plus every `source: letters` persona whose
 * schedule contains the date's UTC weekday (sorted by name). `dateUTC` is YYYY-MM-DD.
 */
export function authorsFor(dateUTC: string, personas: Persona[]): Persona[] {
  const date = new Date(`${dateUTC}T00:00:00Z`);
  const pair = ROTATION[daysSinceUnixEpoch(date) % 3];
  const weekday = weekdayOf(date);

  const byName = new Map(personas.map((p) => [p.name, p]));
  const news = pair
    .map((name) => byName.get(name))
    .filter((p): p is Persona => p !== undefined && p.source === "news");
  const letters = personas
    .filter((p) => p.source === "letters" && (p.schedule ?? []).includes(weekday))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...news, ...letters];
}

/**
 * The selection pool: records that are on the site (publishable), not opinion pieces
 * (nor OPINION-categorized), and first seen within the candidate window. Newest-first
 * for a deterministic gate-prompt order.
 */
export function opinionCandidates(manifest: Manifest, nowMs: number): ManifestRecord[] {
  const windowMs = CANDIDATE_WINDOW_HOURS * 3600_000;
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
 * Sample up to `k` records without replacement, weighting each by the persona's bias
 * for its section (unlisted sections get FLOOR_WEIGHT — rare, never zero). `rng` is a
 * uniform [0,1) source; cumulative-weight walk per draw.
 */
export function weightedSample(
  candidates: ManifestRecord[],
  bias: Partial<Record<Category, number>>,
  k: number,
  rng: () => number,
): ManifestRecord[] {
  const remaining = [...candidates];
  const picked: ManifestRecord[] = [];
  const weightOf = (r: ManifestRecord): number =>
    (r.category !== undefined ? bias[r.category] : undefined) ?? FLOOR_WEIGHT;

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
      "Write one reader-letter column: invent the letter per your instructions above, " +
        `open with it in your column's format, then answer it in your voice. ${titleRule}`,
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
export function splitTitleBody(text: string): { title: string; body: string } | null {
  const unfenced = stripWrappingFence(text);
  if (looksLikeRefusal(unfenced)) return null;
  const trimmed = recoverLeadingTitleRegion(unfenced);
  const newline = trimmed.indexOf("\n");
  if (newline < 0) return null;
  const title = stripTitleDressing(trimmed.slice(0, newline));
  const body = trimmed.slice(newline + 1).trim();
  if (title.length === 0 || body.length === 0) return null;
  if (title.length > MAX_TITLE_CHARS || wordCount(title) > MAX_TITLE_WORDS) return null;
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
      : "the news story the piece reacts to (see the source articles below)";
  const articleBlocks =
    persona.source === "letters"
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
    const candidates = opinionCandidates(manifest, deps.now().getTime());
    if (candidates.length === 0) {
      gateSummary = "gate not run (no candidates)";
      log(`opinions: no candidate stories in the last ${CANDIDATE_WINDOW_HOURS}h`);
    } else {
      // The incumbent Claude classifier (the pre-ADR-0022 gate); null on provider/parse failure.
      const claudeGate = async (): Promise<Map<string, GateVerdict> | null> => {
        let response: string | null = null;
        try {
          response = await deps.generate(buildGatePrompt(candidates));
        } catch {
          response = null;
        }
        return response == null
          ? null
          : parseGateVerdicts(response, candidates.map((r) => r.id));
      };

      // Opt-in TTS gate (ADR-0022). When TTS is unavailable it now FAILS OVER to the Claude gate
      // (owner directive 2026-07-14) rather than fail-closed: Claude still runs the safety
      // classification, so news-opinion pieces aren't silently starved by a TTS flap. Only when
      // BOTH the TTS gate and the Claude fallback fail do we fail closed. The underlying TTS
      // failure is recorded by the client observer → surfaces in the loud TTS-DEGRADED report.
      let verdicts: Map<string, GateVerdict> | null;
      let gateVia = deps.ttsGate ? "TTS" : "Claude";
      if (deps.ttsGate) {
        try {
          verdicts = await deps.ttsGate(candidates);
        } catch {
          verdicts = null;
        }
        if (verdicts == null) {
          gateVia = "Claude (TTS failover)";
          log("opinions: opinion-gate TTS unavailable → failing over to the Claude gate");
          verdicts = await claudeGate();
        }
      } else {
        verdicts = await claudeGate();
      }
      if (verdicts == null) {
        gateFailed = true;
        gateSummary = `gate failed closed (${candidates.length} candidate(s) excluded)`;
        log(
          `opinions: TOPIC GATE FAILED CLOSED — all ${candidates.length} candidate(s) ` +
            "excluded this run (both TTS and Claude gate unavailable, or malformed verdict JSON)",
        );
      } else {
        gate = candidates.map((r) => verdicts.get(r.id) as GateVerdict);
        for (const v of gate) {
          log(`opinions: gate ${v.verdict} ${v.id}${v.reason ? ` — ${v.reason}` : ""}`);
        }
        eligible = candidates.filter((r) => verdicts.get(r.id)?.verdict === "eligible");
        gateSummary = `gate passed ${eligible.length}/${candidates.length} candidate(s) via ${gateVia}`;
        log(`opinions: ${gateSummary}`);
      }
    }
  }

  // Per-author, serially (the subscription CLIs behave badly in parallel), each isolated:
  // a throw or failed generation marks THAT author failed and the loop continues.
  for (const persona of remaining) {
    const key = opinionKey(persona.name, date);
    try {
      let picks: ManifestRecord[] = [];
      if (persona.source === "news") {
        picks = weightedSample(eligible, persona.selectionBias, 3, rng);
        if (picks.length === 0) {
          const detail = gateFailed
            ? "topic gate failed closed"
            : "no eligible candidates after the topic gate";
          outcomes.push({ author: persona.name, key, status: "skipped-no-candidates", detail });
          log(`opinions: ${persona.name} skipped — ${detail}`);
          continue;
        }
        log(`opinions: ${persona.name} selected ${picks.map((r) => r.id).join(", ")}`);
      }

      if (dryRun) {
        outcomes.push({
          author: persona.name,
          key,
          status: "would-publish",
          ...(persona.source === "news"
            ? { sourceArticleIds: picks.map((r) => r.id) }
            : undefined),
        });
        log(`opinions (dry-run): ${persona.name} would publish ${key}`);
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

        const split = splitTitleBody(piece);
        if (split == null) {
          note("output missing title line or body");
          continue;
        }

        // Length sanity per the persona's spec: wildly out of band (>2x) fails the author;
        // merely out of range is a warning — voice beats word count.
        const [min, max] = lengthRangeFor(persona);
        const words = wordCount(split.body);
        if (words < min / 2 || words > max * 2) {
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
          ...(persona.source === "news"
            ? { sourceArticleIds: picks.map((r) => r.id) }
            : undefined),
        };
        manifest.stories[key] = record;
        outcomes.push({
          author: persona.name,
          key,
          status: "published",
          ...(persona.source === "news"
            ? { sourceArticleIds: picks.map((r) => r.id) }
            : undefined),
        });
        log(`opinions: ${persona.name} published ${key} (${words} words)`);
        published = true;
      }
      if (!published) {
        outcomes.push({ author: persona.name, key, status: "failed", detail: lastDetail });
        log(`opinions: ${persona.name} FAILED — ${lastDetail} (${MAX_PIECE_ATTEMPTS} attempts)`);
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
  return `${count("published")} published, ${skipped} skipped, ${count("failed")} failed; ${result.gateSummary}`;
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
