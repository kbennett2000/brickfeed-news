/**
 * CLI entry for the opinion generation stage (ADR-0015, `npm run opinions`). Loads
 * config.json + the manifest + the persona assets, runs the stage for one day, persists
 * the manifest (unless --dry-run), prints per-author outcomes, and exits non-zero ONLY
 * when every derived author failed (skips are not failures).
 *
 * Usage: `npm run opinions -- [--date YYYY-MM-DD] [--authors all|name,name] [--dry-run]`
 *   --date     derivation + idempotency keys only; the 24h candidate window always keys
 *              off the real clock (missed days are never backfilled, ADR-0013 d.3)
 *   --authors  `all` = every loaded persona (the launch batch); a comma list = exactly
 *              those personas (unknown name → usage error); default = today's derived set
 *   --dry-run  prints derived authors, gate verdicts, selections, and would-publish keys;
 *              makes the ONE gate classification call but zero piece generations and
 *              zero writes
 *
 * Text generation is keyless at run time (subscription CLIs); no storage is touched, so
 * no BLOB token is needed.
 */
import { loadConfig } from "./config.js";
import { createTextGenerator } from "./generator/text.js";
import { readManifest, writeManifest } from "./manifest.js";
import { createOpinionTtsDeps } from "./opinions-tts.js";
import { runOpinions, summarizeOpinions } from "./opinions.js";
import { loadPersonaAssets } from "./personas.js";

interface OpinionsArgs {
  date?: string;
  /** undefined = derived set; [] never occurs (usage()s instead). */
  authors?: string[];
  all: boolean;
  dryRun: boolean;
}

function usage(): never {
  console.error(
    [
      "usage: npm run opinions -- [--date YYYY-MM-DD] [--authors all|name,name] [--dry-run]",
      "         --date      derive authors + keys for this UTC day (default: today)",
      "         --authors   all = every persona (launch batch); or a comma-separated list",
      "         --dry-run   gate + selection only: zero writes, zero piece generations",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): OpinionsArgs {
  const args: OpinionsArgs = { all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage();
      return v;
    };
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--date") {
      const d = next();
      // Calendar-valid too: round-tripping through Date catches 2026-02-31 etc.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) usage();
      const parsed = new Date(`${d}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) usage();
      args.date = d;
    } else if (arg === "--authors") {
      const v = next();
      if (v === "all") args.all = true;
      else {
        args.authors = v.split(",").map((s) => s.trim());
        if (args.authors.length === 0 || args.authors.some((s) => s.length === 0)) usage();
      }
    } else usage();
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = await loadConfig("config.json");
  const manifest = await readManifest(config.manifestPath);
  const assets = await loadPersonaAssets();

  // `--authors all` is the launch batch: every loaded persona, schedule/rotation ignored.
  const authors = args.all ? assets.personas.map((p) => p.name) : args.authors;
  if (authors) {
    const known = new Set(assets.personas.map((p) => p.name));
    for (const name of authors) {
      if (!known.has(name)) {
        console.error(
          `unknown persona "${name}" — available: ${[...known].sort().join(", ")}`,
        );
        process.exit(1);
      }
    }
  }

  const result = await runOpinions(
    config,
    manifest,
    assets,
    {
      generate: createTextGenerator(config, {}, console.log),
      now: () => new Date(),
      log: console.log,
      ...createOpinionTtsDeps(config),
    },
    { date: args.date, authors, dryRun: args.dryRun },
  );

  if (!args.dryRun) {
    await writeManifest(config.manifestPath, result.manifest);
  }

  console.log(
    `\nopinions ${result.date}${args.dryRun ? " (dry-run)" : ""}: ${summarizeOpinions(result)}`,
  );
  for (const o of result.authors) {
    const extra = [
      o.detail,
      o.sourceArticleIds ? `sources: ${o.sourceArticleIds.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    console.log(`  • ${o.author}: ${o.status} (${o.key})${extra ? ` — ${extra}` : ""}`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error("opinions failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
