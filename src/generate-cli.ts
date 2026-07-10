import { loadConfig } from "./config.js";
import { generateAll } from "./generate.js";
import { createGenerator } from "./generator/index.js";
import { readManifest, writeManifest } from "./manifest.js";
import type { GenerateDeps } from "./types.js";

/**
 * CLI entry for the generation pass. Loads config.json, generates content for
 * pending manifest records, persists the manifest, and prints a summary. Mirrors
 * src/index.ts (the ingestion CLI).
 *
 * Usage: `npm run generate` or `npm run generate -- --limit 3` to cap how many
 * pending stories are attempted this run (keeps live/token usage small).
 */
async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));

  const config = await loadConfig("config.json");
  const startingManifest = await readManifest(config.manifestPath);

  const deps: GenerateDeps = {
    generator: createGenerator(config),
    now: () => new Date(),
  };

  const result = await generateAll(config, startingManifest, deps, { limit });
  await writeManifest(config.manifestPath, result.manifest);

  const at = deps.now().toISOString();
  console.log(
    `[${at}] generation: ${result.generated.length} generated, ` +
      `${result.skipped} skipped (already done), ${result.failed} still pending`,
  );
  for (const s of result.generated) {
    console.log(`  • [${s.id.slice(0, 12)}] ${s.headline}`);
    console.log(`    ${s.description}`);
  }
}

/** Parse an optional `--limit N` (or `--limit=N`) argument; undefined if absent/invalid. */
function parseLimit(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const n = Number(argv[i + 1]);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
    if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
}

main().catch((err) => {
  console.error("generation failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
