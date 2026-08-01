/**
 * Persona voice bench — iterate on the Opinion personas (ADR-0013) without touching the
 * pipeline. Assembles the real opinion prompt (personas/_shared.md + the persona's voice
 * prompt + a set of article texts), sends it through the free-form text seam
 * (createTextGenerator — the SAME provider abstraction the future opinion stage will use),
 * and prints each piece with a word count for side-by-side reading.
 *
 * This is an OPT-IN operator harness, deliberately NOT part of `npm test` (mock-first and
 * offline by contract, CLAUDE.md). It never writes to the store or the site.
 *
 *   npm run bench:personas -- --persona alice
 *   npm run bench:personas -- --all
 *   npm run bench:personas -- --all --recent 3
 *   npm run bench:personas -- --persona bob --provider grok-terminal
 *
 * Articles come from fixtures/opinion-bench/*.txt by default (offline, deterministic;
 * every file read verbatim as one article, in filename order). `--fixtures <dir>` points
 * elsewhere; `--recent <n>` instead pulls the n newest published stories and synthesizes
 * article blocks from their rewritten headline/description (the store keeps no original
 * article bodies). `--all` runs every persona against the SAME article set. Exits non-zero
 * on a failed generation or an unknown persona.
 *
 * `source: letters` personas (ADR-0014) run in LETTER MODE instead: no article inputs
 * (`--fixtures`/`--recent` are irrelevant to them, and articles are only loaded when a
 * news persona is selected), and the prompt is _shared.md + _letters.md + the voice
 * prompt. Every piece's word count is judged against the persona's OWN band
 * (lengthRangeFor: a per-persona override like Alice/Edgar, else the shared default).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createTextGenerator } from "../src/generator/text.js";
import { lengthRangeFor } from "../src/opinions.js";
import {
  LETTERS_PERSONA_FILE,
  PERSONAS_DIR,
  SHARED_PERSONA_FILE,
  loadPersonas,
  type Persona,
} from "../src/personas.js";
import type { ManifestRecord } from "../src/types.js";

const DEFAULT_FIXTURES_DIR = "fixtures/opinion-bench";
const PROVIDERS = ["grok-terminal", "claude", "grok"] as const;

interface BenchArgs {
  persona?: string;
  all: boolean;
  fixturesDir: string;
  recent?: number;
  provider?: (typeof PROVIDERS)[number];
}

function usage(): never {
  console.error(
    [
      "usage: npm run bench:personas -- (--persona <name> | --all)",
      "         [--fixtures <dir>]   article .txt files (default fixtures/opinion-bench)",
      "         [--recent <n>]       use the n newest published stories instead of fixtures",
      `         [--provider <p>]     override config.generator.provider (${PROVIDERS.join(" | ")})`,
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { all: false, fixturesDir: DEFAULT_FIXTURES_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage();
      return v;
    };
    if (arg === "--all") args.all = true;
    else if (arg === "--persona") args.persona = next();
    else if (arg === "--fixtures") args.fixturesDir = next();
    else if (arg === "--recent") {
      const n = Number.parseInt(next(), 10);
      if (!Number.isFinite(n) || n <= 0) usage();
      args.recent = n;
    } else if (arg === "--provider") {
      const p = next();
      if (!(PROVIDERS as readonly string[]).includes(p)) usage();
      args.provider = p as BenchArgs["provider"];
    } else usage();
  }
  // Exactly one of --persona / --all.
  if (args.all === (args.persona !== undefined)) usage();
  return args;
}

/** Fixture mode: every *.txt in the dir, read verbatim, in filename order. */
async function fixtureBlocks(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".txt")).sort();
  return Promise.all(files.map((f) => readFile(join(dir, f), "utf8").then((t) => t.trim())));
}

/**
 * Store mode: the n newest published stories, as synthesized blocks. published.json keeps
 * no article bodies, so each block is our rewritten headline + description plus the feed
 * title/source for grounding.
 */
async function recentBlocks(publishedPath: string, n: number): Promise<string[]> {
  const records = JSON.parse(await readFile(publishedPath, "utf8")) as ManifestRecord[];
  return records.slice(0, n).map((r) => {
    const lines = [r.headline ?? r.title];
    if (r.description) lines.push(r.description);
    lines.push(`(via ${r.sourceName}: ${r.title})`);
    return lines.join("\n");
  });
}

/** The real opinion prompt shape: shared register/guardrails + voice + articles + task. */
function buildBenchPrompt(shared: string, persona: Persona, blocks: string[]): string {
  const articles = blocks.map((b, i) => `ARTICLE ${i + 1}:\n${b}`).join("\n\n");
  const [min, max] = lengthRangeFor(persona);
  return [
    shared.trim(),
    persona.body,
    articles,
    `Write one ${min}-${max} word opinion piece reacting to ONE of the articles above. ` +
      "Output only the piece itself - no title, no preamble, no commentary.",
  ].join("\n\n");
}

/** Letter mode (ADR-0014): shared register + letter-invention rules + voice + task. */
function buildLetterPrompt(shared: string, letters: string, persona: Persona): string {
  const [min, max] = lengthRangeFor(persona);
  return [
    shared.trim(),
    letters.trim(),
    persona.body,
    `Write one ${min}-${max} word reader-letter column: invent the letter per your ` +
      "instructions above, open with it in your column's format, then answer it in your " +
      "voice. Output only the piece itself - no title, no preamble, no commentary.",
  ].join("\n\n");
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const loaded = await loadConfig("config.json");
  const config = args.provider
    ? { ...loaded, generator: { ...loaded.generator, provider: args.provider } }
    : loaded;

  const personas = await loadPersonas();
  const selected = args.all ? personas : personas.filter((p) => p.name === args.persona);
  if (selected.length === 0) {
    console.error(
      `unknown persona "${args.persona}" — available: ${personas.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }

  const shared = await readFile(join(PERSONAS_DIR, SHARED_PERSONA_FILE), "utf8");

  // Inputs are lazy per source: articles only when a news persona runs (so
  // `--persona tom` needs no fixture args), the letters block only when a letters
  // persona runs.
  const anyNews = selected.some((p) => p.source === "news");
  const anyLetters = selected.some((p) => p.source === "letters");
  const blocks = anyNews
    ? args.recent
      ? await recentBlocks(config.publishedPath, args.recent)
      : await fixtureBlocks(args.fixturesDir)
    : [];
  if (anyNews && blocks.length === 0) {
    console.error("no articles to react to (empty fixtures dir / published store)");
    process.exit(1);
  }
  const letters = anyLetters ? await readFile(join(PERSONAS_DIR, LETTERS_PERSONA_FILE), "utf8") : "";

  const provider = config.generator.provider;
  // Mirror production opinions: the opinion text seam is pinned to the opinion model override
  // when set (config.generator.opinionModel), so the bench shows what the columns will produce.
  const opinionModel = config.generator.opinionModel;
  const generate = createTextGenerator(config, {}, () => {}, opinionModel);
  const modelNote = provider === "claude" ? ` · model=${opinionModel ?? config.generator.model}` : "";
  const articleNote = anyNews
    ? `${blocks.length} article(s) (${args.recent ? `--recent ${args.recent}` : args.fixturesDir})`
    : "letter mode (no articles)";
  console.log(
    `persona bench · ${selected.length} persona(s) · ${articleNote} · provider=${provider}${modelNote}\n`,
  );

  let failures = 0;
  for (const persona of selected) {
    const mode = persona.source === "letters" ? " · letters" : "";
    console.log(`── ${persona.name} · ${persona.displayName} · provider=${provider}${mode} ──`);
    const started = Date.now();
    const prompt =
      persona.source === "letters"
        ? buildLetterPrompt(shared, letters, persona)
        : buildBenchPrompt(shared, persona, blocks);
    const piece = await generate(prompt);
    const ms = Date.now() - started;

    if (piece == null) {
      failures += 1;
      console.log(`✗ FAIL — generation returned null  [${ms}ms]\n`);
      continue;
    }

    const words = wordCount(piece);
    // Verdict against the persona's OWN band (lengthRangeFor: per-persona override or the
    // shared default) so overrides like Alice/Edgar aren't mislabelled out of range.
    const [min, max] = lengthRangeFor(persona);
    const range =
      words >= min && words <= max ? `  [in range ${min}-${max}]` : `  [OUT OF RANGE ${min}-${max}]`;
    console.log(piece);
    console.log(`\nwords: ${words}${range}  [${ms}ms]\n`);
  }

  if (failures > 0) {
    console.log(`${failures}/${selected.length} generation(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`bench:personas crashed: ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
