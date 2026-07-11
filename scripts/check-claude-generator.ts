/**
 * Live check — does the REAL Claude CLI (Haiku by default) produce every text
 * artifact the pipeline needs, at comparable quality to Grok?
 *
 * This is an OPT-IN operator harness, deliberately NOT part of `npm test` (which is
 * mock-first and offline by contract, CLAUDE.md). It drives the real `claude -p`
 * CLI through the production `SubscriptionGenerator` — no injected runner — over a
 * handful of diverse stories, then validates and prints each result so you can
 * eyeball quality before switching `generator.provider` to "claude". Image
 * generation is untouched: it stays on Grok.
 *
 *   npm run check:claude
 *   npm run check:claude -- --model=claude-sonnet-5
 *
 * Needs the `claude` CLI logged in — `CLAUDE_CODE_OAUTH_TOKEN` (from
 * `claude setup-token`) or a stored login. Exits non-zero if any story fails a HARD
 * check (null result, a missing/empty text artifact, or an out-of-taxonomy category),
 * so a green run is the go-ahead to flip the config.
 *
 * Guardrail note: per CLAUDE.md the forbidden brand marks must appear NOWHERE in
 * code, so this harness never greps outputs for any trademark string. Brand /
 * written-words-in-scene review is left to the printed-output eyeball; the automated
 * checks here are purely structural (presence, non-empty, valid category, lengths).
 */

import { CATEGORIES } from "../src/category.js";
import { SubscriptionGenerator } from "../src/generator/subscription.js";
import { getSubscriptionToken } from "../src/secrets.js";
import type { GenerationInput, GeneratorOutput } from "../src/types.js";

/** What the production switch would use ("Haiku by default"); override with --model=. */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * A small, deliberately diverse set of real-shaped stories spanning several sections,
 * to exercise the rewrite, the image-prompt guardrails, and the category classifier.
 * These are plausible headlines, not copied from any specific article.
 */
const STORIES: GenerationInput[] = [
  {
    title: "Senate passes sweeping infrastructure bill after marathon overnight session",
    sourceName: "Capitol Wire",
    url: "https://example.com/politics/infrastructure-bill",
  },
  {
    title: "Chipmaker unveils next-generation AI accelerator, claims triple the performance",
    sourceName: "TechDaily",
    url: "https://example.com/tech/ai-accelerator",
  },
  {
    title: "Underdog side stuns defending champions in extra-time cup final thriller",
    sourceName: "Match Report",
    url: "https://example.com/sport/cup-final-upset",
  },
  {
    title: "Astronomers detect unusual radio signal from distant dwarf galaxy",
    sourceName: "Orbit Journal",
    url: "https://example.com/science/radio-signal",
  },
  {
    title: "Central bank holds interest rates steady as inflation cools further",
    sourceName: "Market Ledger",
    url: "https://example.com/business/rates-hold",
  },
];

function parseModel(argv: string[]): string {
  for (const arg of argv) {
    const m = arg.match(/^--model=(.+)$/);
    if (m) return m[1];
  }
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Lowercase alphanumerics only — for a lenient "is the headline just the title?" compare. */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface Check {
  ok: boolean;
  label: string;
  detail?: string;
}

/** Structural HARD checks (any failure fails the run) + SOFT quality checks (warn only). */
function validate(
  input: GenerationInput,
  out: GeneratorOutput,
): { hard: Check[]; soft: Check[] } {
  const hard: Check[] = [
    { ok: out.headline.trim().length > 0, label: "headline present" },
    { ok: out.description.trim().length > 0, label: "description present" },
    { ok: out.imagePrompt.trim().length > 0, label: "imagePrompt present" },
    { ok: out.caption.trim().length > 0, label: "caption present" },
    {
      ok: (CATEGORIES as readonly string[]).includes(out.category),
      label: "category in taxonomy",
      detail: out.category,
    },
  ];

  const headlineWc = wordCount(out.headline);
  const promptWc = wordCount(out.imagePrompt);
  const captionWc = wordCount(out.caption);
  const verbatim = normalizeForCompare(out.headline) === normalizeForCompare(input.title);

  const soft: Check[] = [
    {
      ok: !verbatim,
      label: "headline is an original rewrite (not verbatim source title)",
    },
    {
      ok: promptWc >= 8 && promptWc <= 40,
      label: "imagePrompt length sane (~15-30 words)",
      detail: `${promptWc} words`,
    },
    {
      ok: captionWc >= 5 && captionWc <= 25,
      label: "caption length sane (~8-15 words)",
      detail: `${captionWc} words`,
    },
    {
      ok: headlineWc >= 4,
      label: "headline is a full sentence",
      detail: `${headlineWc} words`,
    },
  ];

  return { hard, soft };
}

function printChecks(checks: Check[]): void {
  for (const c of checks) {
    const mark = c.ok ? "  ✓" : "  ✗";
    const detail = c.detail ? ` (${c.detail})` : "";
    console.log(`${mark} ${c.label}${detail}`);
  }
}

async function main(): Promise<void> {
  const model = parseModel(process.argv.slice(2));

  console.log("Claude generator live check");
  console.log(`  model:   ${model}`);
  console.log(`  stories: ${STORIES.length}`);
  if (!getSubscriptionToken()) {
    console.log(
      "  note:    CLAUDE_CODE_OAUTH_TOKEN is not set; relying on the Claude CLI's " +
        "stored login. Run `claude setup-token` if generation fails.",
    );
  }
  console.log("");

  const gen = new SubscriptionGenerator({ model });

  let hardFailures = 0;
  let softWarnings = 0;

  for (const [i, input] of STORIES.entries()) {
    console.log(`── Story ${i + 1}/${STORIES.length} ─────────────────────────────────`);
    console.log(`source title: ${input.title}`);
    console.log(`publisher:    ${input.sourceName}`);

    const started = Date.now();
    let out: GeneratorOutput | null;
    try {
      out = await gen.generate(input);
    } catch (err) {
      // generate() is documented never-throw, but a harness must survive anything.
      out = null;
      console.log(`  ✗ generate() threw: ${(err as Error).message}`);
    }
    const ms = Date.now() - started;

    if (out == null) {
      hardFailures += 1;
      console.log(`  ✗ FAIL — generate() returned null (story would stay pending)  [${ms}ms]`);
      console.log("");
      continue;
    }

    console.log(`  latency:     ${ms}ms`);
    console.log(`  headline:    ${out.headline}`);
    console.log(`  description: ${out.description}`);
    console.log(`  imagePrompt: ${out.imagePrompt}`);
    console.log(`  category:    ${out.category}`);
    console.log(`  caption:     ${out.caption}`);

    const { hard, soft } = validate(input, out);
    const hardOk = hard.every((c) => c.ok);
    const softOk = soft.every((c) => c.ok);
    if (!hardOk) hardFailures += 1;
    softWarnings += soft.filter((c) => !c.ok).length;

    console.log("  hard checks:");
    printChecks(hard);
    console.log("  quality checks (advisory):");
    printChecks(soft);
    console.log(
      `  → ${hardOk ? "PASS" : "FAIL"}${hardOk && !softOk ? " (with quality warnings)" : ""}`,
    );
    console.log("");
  }

  const passed = STORIES.length - hardFailures;
  console.log("════════════════════════════════════════════════");
  console.log(`${passed}/${STORIES.length} passed hard checks · ${softWarnings} quality warning(s)`);
  if (hardFailures > 0) {
    console.log("Result: FAIL — do not switch until Claude produces all artifacts.");
    process.exitCode = 1;
  } else {
    console.log("Result: PASS — Claude produced every required artifact. Eyeball the");
    console.log("output above for quality, then flip generator.provider to \"claude\".");
  }
}

main().catch((err) => {
  console.error(`check:claude crashed: ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
