/**
 * Opinion personas (ADR-0013): the six fictional, clearly-disclosed AI authors live as
 * versioned prompt assets under `personas/*.md`. Each file is a `---`-fenced front-matter
 * block (name / display_name / byline_blurb / selection_bias) followed by the persona's
 * voice prompt — the body handed to the text generator, after `personas/_shared.md` (the
 * shared register + guardrail block, which has no front-matter and is not a persona).
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
  /** Section → selection weight steering which articles this persona reacts to. */
  selectionBias: Partial<Record<Category, number>>;
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
 * Pure and never throws. Returns null — this is not a valid persona — when the fences are
 * missing/unterminated, a required field (name, display_name, byline_blurb) or the body is
 * empty, a selection_bias key is not exactly one of CATEGORIES (no normalization: a typo
 * must not silently become WORLD), or a weight is not a finite number ≥ 0.
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
  let inBias = false;
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
      inBias = true;
      continue;
    }
    if (key.length > 0) scalars.set(key, value);
  }
  if (!closed) return null;

  const name = scalars.get("name") ?? "";
  const displayName = scalars.get("display_name") ?? "";
  const bylineBlurb = scalars.get("byline_blurb") ?? "";
  const body = lines.slice(i).join("\n").trim();
  if (name.length === 0 || displayName.length === 0 || bylineBlurb.length === 0) return null;
  if (body.length === 0) return null;

  return { name, displayName, bylineBlurb, selectionBias, body };
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
