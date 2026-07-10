import { loadConfig } from "./config.js";
import { ingest } from "./ingest.js";
import { readManifest, writeManifest } from "./manifest.js";
import type { FetchLike, IngestDeps } from "./types.js";

/**
 * CLI entry for the ingestion backbone. Loads config.json, runs one ingest pass,
 * persists the manifest, and prints a summary of NEW stories. No env vars.
 */
async function main(): Promise<void> {
  const config = await loadConfig("config.json");
  const startingManifest = await readManifest(config.manifestPath);

  const deps: IngestDeps = {
    // Node's global fetch satisfies the structural FetchLike shape.
    fetch: fetch as unknown as FetchLike,
    now: () => new Date(),
  };

  const result = await ingest(config, startingManifest, deps);
  await writeManifest(config.manifestPath, result.manifest);

  const total = Object.keys(result.manifest.stories).length;
  console.log(
    `${result.newStories.length} new stories ` +
      `(${result.knownCount} known this run, ${total} total in manifest)`,
  );
  for (const s of result.newStories) {
    console.log(`  • [${s.id.slice(0, 12)}] ${s.sourceName || "unknown source"}`);
    console.log(`    ${s.title}`);
    console.log(`    ${s.url}`);
  }
}

main().catch((err) => {
  console.error("ingest failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
