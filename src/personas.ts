/**
 * Opinion personas (ADR-0013, ADR-0014): the fictional, clearly-disclosed AI authors live
 * as versioned prompt assets under `personas/*.md`. Each file is a `---`-fenced front-matter
 * block (name / display_name / byline_blurb / source, plus source-specific fields) followed
 * by the persona's voice prompt — the body handed to the text generator, after
 * `personas/_shared.md` (the shared register + guardrail block, which has no front-matter
 * and is not a persona).
 *
 * Two sources (ADR-0014 decision 1): `source: news` personas react to selected articles and
 * carry a `selection_bias` block; `source: letters` personas invent a fictional reader
 * letter and answer it, carrying a `schedule` (UTC weekdays) and a `column_title` instead.
 * The letter-invention guardrails live in `personas/_letters.md`, prepended after
 * `_shared.md` for letters personas only.
 *
 * Front-matter is deliberately STRICT: personas are creator-authored committed assets, so
 * a typo'd section name or a missing field should fail loudly (parsePersona → null, which
 * the schema test turns into a red build) rather than silently launder into a default.
 * Loading stays tolerant, matching ads/articles: a bad persona file is logged and skipped
 * so it can never break a publish cycle.
 *
 * Parsing (`parsePersona`) is a pure, unit-testable seam; IO boundaries are injected.
 */
import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import { CATEGORIES, type Category } from "./category.js";

/** The default folder persona assets live in (relative to the run's cwd). */
export const PERSONAS_DIR = "personas";

/** The shared register/guardrail block prepended to every opinion prompt (not a persona). */
export const SHARED_PERSONA_FILE = "_shared.md";

/**
 * The letter-invention guardrail block (ADR-0014 decision 5), prepended after `_shared.md`
 * for `source: letters` personas only (not a persona itself — `_` keeps it off the roster).
 */
export const LETTERS_PERSONA_FILE = "_letters.md";

/**
 * The reader-comments register/comedy/guardrail block (ADR-0028), prepended to every comment-
 * generation prompt. Hand-authored + versioned like `_shared.md`; not a persona (`_` keeps it off
 * the roster).
 */
export const COMMENTS_PERSONA_FILE = "_comments.md";

/**
 * The evergreen last-resort block (ADR-0032 Layer D), prepended after `_shared.md` when a
 * `source: news` persona has no eligible source story (grim-day fallback). It overrides the
 * shared "react only to the source articles" rule with a no-source, no-news contract so every
 * scheduled news columnist still publishes. Hand-authored + versioned; not a persona.
 */
export const EVERGREEN_PERSONA_FILE = "_evergreen.md";

/**
 * Directory (under the personas dir) of committed, hand-written CANNED fallback columns, one
 * `<name>.md` per persona (ADR-0033 Layer 2a). Published verbatim as the terminal last resort when
 * live generation fails every attempt — model- and network-independent, so a fully degraded backend
 * can never leave a scheduled columnist unpublished. First non-blank line = title, rest = body.
 */
export const FALLBACKS_DIR = "fallbacks";

/** A parsed canned fallback column: a title line + body, published as-is. */
export interface FallbackPiece {
  title: string;
  body: string;
}

/** Parse a canned fallback file: first non-blank line = title, remainder = body. Null if empty. */
export function parseFallback(text: string): FallbackPiece | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length) return null;
  const title = lines[i].trim();
  const body = lines.slice(i + 1).join("\n").trim();
  if (title.length === 0 || body.length === 0) return null;
  return { title, body };
}

/** Where a persona's pieces come from (ADR-0014 decision 1). */
export type PersonaSource = "news" | "letters";

/** Lowercase UTC weekday tokens, the only accepted `schedule` vocabulary. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** One opinion author, parsed from `personas/<name>.md`. */
export interface Persona {
  /**
   * Canonical id — must equal the file's basename. It keys the headshot
   * (`assets/headshots/<name>.png`) and the future `opinion-<name>-<date>` idempotency key.
   */
  name: string;
  /** Byline name shown on pieces and cards. */
  displayName: string;
  /** The hand-written disclosure footer for this author's pieces (ADR-0013 decision 6). */
  bylineBlurb: string;
  /**
   * Human-written bio paragraphs for the columnist page (ADR-0019) — never
   * model-generated. Absent → the bio page falls back to `bylineBlurb`.
   */
  bio?: string[];
  /** `news` reacts to articles; `letters` invents and answers a fictional reader letter. */
  source: PersonaSource;
  /**
   * Section → selection weight steering which articles this persona reacts to.
   * Required (non-empty) for `news`; forbidden for `letters` (always {} there).
   */
  selectionBias: Partial<Record<Category, number>>;
  /**
   * `news` only (ADR-0032 Layer E). When true the persona writes ONLY the sections it
   * explicitly lists in `selectionBias` — unlisted sections are hard-excluded from its
   * candidate pool, with no FLOOR_WEIGHT leakage. Used to bind Hodge to SPORTS.
   */
  sectionsExclusive?: boolean;
  /** UTC weekdays this letters persona posts on — an overlay on the daily rotation pair. */
  schedule?: Weekday[];
  /** The column's banner title on letter pieces (e.g. "Tom's Tech Corner"). */
  columnTitle?: string;
  /** Everything after the closing fence — the persona's voice prompt. */
  body: string;
}

/** Injectable IO boundaries (default to node:fs/promises); tests pass in-memory fakes. */
export interface PersonasDeps {
  readdir: (dir: string) => Promise<string[]>;
  readText: (path: string) => Promise<string>;
  log: (message: string) => void;
}

const defaultDeps: PersonasDeps = {
  readdir: (dir) => fsReaddir(dir),
  readText: (path) => fsReadFile(path, "utf8"),
  log: (message) => console.warn(message),
};

/**
 * Parse a persona document: a `---`-fenced front-matter block of `key: value` scalars
 * (keys lowercased; unknown scalar keys ignored for forward compatibility) where a bare
 * `selection_bias:` line opens a nested block of INDENTED `SECTION: <weight>` lines, then
 * the voice-prompt body after the closing fence.
 *
 * The optional `bio` field (ADR-0019) is either an inline scalar (`bio: text` — one
 * paragraph) or a bare `bio:` line opening a nested block of INDENTED free-prose lines,
 * one paragraph per line. Bio lines are consumed before scalar parsing, so paragraphs
 * may contain colons. An empty block or a re-declared `bio` is a defect (null).
 *
 * Pure and never throws. Returns null — this is not a valid persona — when the fences are
 * missing/unterminated, a required field (name, display_name, byline_blurb, source) or the
 * body is empty, a selection_bias key is not exactly one of CATEGORIES (no normalization: a
 * typo must not silently become WORLD), or a weight is not a finite number ≥ 0.
 *
 * `source` branches the contract (ADR-0014): `news` requires a non-empty selection_bias and
 * forbids schedule/column_title; `letters` requires a schedule (slash-separated lowercase
 * WEEKDAYS tokens, no duplicates) and a column_title, and forbids selection_bias. No case
 * or token normalization anywhere — `MON` and `monday` are rejects, not aliases.
 */
export function parsePersona(text: string): Persona | null {
  const lines = text.split(/\r?\n/);

  // Locate the opening fence: the first non-blank line must be exactly `---`.
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length || lines[i].trim() !== "---") return null;
  i++;

  const scalars = new Map<string, string>();
  const selectionBias: Partial<Record<Category, number>> = {};
  let sawBiasBlock = false;
  let inBias = false;
  let bio: string[] | undefined;
  let inBio = false;
  let closed = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim().length === 0) continue;

    const indented = /^\s/.test(line);
    // Bio paragraphs are free prose (may lack colons), so consume them before the
    // colon check that the rest of the front-matter grammar relies on.
    if (inBio) {
      if (indented) {
        bio!.push(line.trim());
        continue;
      }
      inBio = false;
    }
    if (inBias && !indented) inBias = false;

    const colon = line.indexOf(":");
    if (colon < 0) continue; // stray non-field line — ignore

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (inBias) {
      const section = key.toUpperCase();
      if (!(CATEGORIES as readonly string[]).includes(section)) return null;
      const weight = Number(value);
      if (!Number.isFinite(weight) || weight < 0) return null;
      selectionBias[section as Category] = weight;
      continue;
    }

    if (key === "selection_bias" && value.length === 0) {
      sawBiasBlock = true;
      inBias = true;
      continue;
    }
    if (key === "bio") {
      if (bio !== undefined) return null; // re-declared
      if (value.length === 0) {
        bio = [];
        inBio = true;
      } else {
        bio = [value];
      }
      continue;
    }
    if (key.length > 0) scalars.set(key, value);
  }
  if (!closed) return null;
  if (bio !== undefined && bio.length === 0) return null; // `bio:` block with no paragraphs

  const name = scalars.get("name") ?? "";
  const displayName = scalars.get("display_name") ?? "";
  const bylineBlurb = scalars.get("byline_blurb") ?? "";
  const body = lines.slice(i).join("\n").trim();
  if (name.length === 0 || displayName.length === 0 || bylineBlurb.length === 0) return null;
  if (body.length === 0) return null;

  const source = scalars.get("source") ?? "";
  if (source !== "news" && source !== "letters") return null;

  if (source === "news") {
    // News personas react to selected articles: bias is the selection input, and the
    // letters-only fields must not sneak in and silently mean nothing.
    if (Object.keys(selectionBias).length === 0) return null;
    if (scalars.has("schedule") || scalars.has("column_title")) return null;
    // Optional section-exclusivity flag (ADR-0032). Only the literal `true` enables it;
    // absent/any other value is false. A typo'd value degrades to non-exclusive, never throws.
    const sectionsExclusive = scalars.get("sections_exclusive") === "true";
    return {
      name,
      displayName,
      bylineBlurb,
      ...(bio ? { bio } : {}),
      source,
      selectionBias,
      ...(sectionsExclusive ? { sectionsExclusive: true } : {}),
      body,
    };
  }

  // Letters personas: schedule + column_title required, selection_bias forbidden.
  if (sawBiasBlock) return null;
  const schedule = parseSchedule(scalars.get("schedule"));
  const columnTitle = scalars.get("column_title") ?? "";
  if (!schedule || columnTitle.length === 0) return null;

  return {
    name,
    displayName,
    bylineBlurb,
    ...(bio ? { bio } : {}),
    source,
    selectionBias,
    schedule,
    columnTitle,
    body,
  };
}

/**
 * Parse a `schedule` scalar: slash-separated lowercase WEEKDAYS tokens, e.g.
 * `mon/wed/fri/sun`. Null on absent/empty, an unknown or non-lowercase token, or a
 * duplicate — same strictness as the rest of the front-matter.
 */
function parseSchedule(raw: string | undefined): Weekday[] | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const tokens = raw.split("/").map((t) => t.trim());
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!(WEEKDAYS as readonly string[]).includes(token)) return null;
    if (seen.has(token)) return null;
    seen.add(token);
  }
  return tokens as Weekday[];
}

/**
 * The full asset bundle the opinion generation stage consumes (ADR-0015): the parsed
 * roster plus the two shared prompt blocks, read once per run.
 */
export interface OpinionAssets {
  personas: Persona[];
  /** Contents of `_shared.md` — prepended to every opinion prompt. */
  shared: string;
  /** Contents of `_letters.md` — prepended after `shared` for letters personas only. */
  letters: string;
  /** Contents of `_comments.md` — prepended to every reader-comment prompt (ADR-0028). */
  comments: string;
  /** Contents of `_evergreen.md` — the no-source fallback block for news personas (ADR-0032). */
  evergreen: string;
  /**
   * Canned last-resort columns keyed by persona name (ADR-0033 Layer 2a). Published verbatim when
   * every live generation attempt fails. Tolerant: a persona with no file is simply absent (that
   * author falls back to `failed` as before) — a missing/unreadable dir yields `{}`.
   */
  fallbacks: Record<string, FallbackPiece>;
}

/**
 * Load the personas plus the shared/letters/comments prompt blocks from `dir`. Unlike
 * `loadPersonas`, a missing `_shared.md`/`_letters.md`/`_comments.md` THROWS: the roster degrades
 * per-file by design, but the shared guardrail blocks are load-bearing for every generated piece
 * or comment thread, so generating without them must be impossible.
 */
export async function loadPersonaAssets(
  dir: string = PERSONAS_DIR,
  deps: Partial<PersonasDeps> = {},
): Promise<OpinionAssets> {
  const io: PersonasDeps = { ...defaultDeps, ...deps };
  const personas = await loadPersonas(dir, deps);
  const shared = await io.readText(`${dir}/${SHARED_PERSONA_FILE}`);
  const letters = await io.readText(`${dir}/${LETTERS_PERSONA_FILE}`);
  const comments = await io.readText(`${dir}/${COMMENTS_PERSONA_FILE}`);
  const evergreen = await io.readText(`${dir}/${EVERGREEN_PERSONA_FILE}`);
  const fallbacks = await loadFallbacks(`${dir}/${FALLBACKS_DIR}`, io);
  return { personas, shared, letters, comments, evergreen, fallbacks };
}

/**
 * Load the committed canned fallback columns (ADR-0033). Tolerant by design — unlike the shared
 * blocks, a missing/unreadable fallbacks dir or file must NEVER break a cycle: it yields `{}` / skips
 * the file, and that persona simply has no last resort. Keyed by the file's basename (= persona name).
 */
async function loadFallbacks(
  dir: string,
  io: PersonasDeps,
): Promise<Record<string, FallbackPiece>> {
  let entries: string[];
  try {
    entries = await io.readdir(dir);
  } catch {
    return {};
  }
  const out: Record<string, FallbackPiece> = {};
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    try {
      const parsed = parseFallback(await io.readText(`${dir}/${file}`));
      if (parsed) out[file.slice(0, -".md".length)] = parsed;
    } catch {
      // A single unreadable/malformed fallback file is skipped, never fatal.
    }
  }
  return out;
}

/**
 * Read `dir` and parse every persona file: `*.md`, excluding `_`-prefixed files (shared /
 * support assets like `_shared.md`). A missing folder yields []; an unreadable or invalid
 * file — including one whose front-matter `name` differs from its basename, which would
 * desync the headshot and idempotency keys — is logged and skipped rather than thrown.
 * Results are sorted by name.
 */
export async function loadPersonas(
  dir: string = PERSONAS_DIR,
  deps: Partial<PersonasDeps> = {},
): Promise<Persona[]> {
  const io: PersonasDeps = { ...defaultDeps, ...deps };

  let entries: string[];
  try {
    entries = await io.readdir(dir);
  } catch {
    // No personas folder (or unreadable) → no personas. Not an error.
    return [];
  }

  const personas: Persona[] = [];
  for (const file of entries.filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort()) {
    const basename = file.slice(0, -".md".length);
    try {
      const parsed = parsePersona(await io.readText(`${dir}/${file}`));
      if (!parsed) {
        io.log(`personas: ${basename} skipped — invalid or incomplete front-matter/body`);
        continue;
      }
      if (parsed.name !== basename) {
        io.log(
          `personas: ${basename} skipped — front-matter name "${parsed.name}" must equal ` +
            `the file basename`,
        );
        continue;
      }
      personas.push(parsed);
    } catch (err) {
      io.log(`personas: ${basename} skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return personas.sort((a, b) => a.name.localeCompare(b.name));
}
