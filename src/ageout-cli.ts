import { ageOut } from "./ageout.js";
import { loadConfig } from "./config.js";
import { readManifest, writeManifest } from "./manifest.js";
import { writePublished } from "./publish.js";
import { createStorageProvider } from "./storage/index.js";
import type { AgeOutDeps } from "./ageout.js";

/**
 * CLI entry for the age-out pass (Slice 4). Loads config.json, reads the manifest, drops
 * records with no update older than their category's retention window (opinionMaxAgeHours
 * for OPINION, maxAgeHours otherwise; ADR-0013 #5), deletes their stored images for
 * real, then persists the manifest and rewrites published.json. Mirrors the other CLIs.
 *
 * Usage: `npm run ageout`.
 */
async function main(): Promise<void> {
  const config = await loadConfig("config.json");
  const startingManifest = await readManifest(config.manifestPath);

  const deps: AgeOutDeps = {
    storage: createStorageProvider(config),
    now: () => new Date(),
  };

  const result = await ageOut(config, startingManifest, deps);
  await writeManifest(config.manifestPath, result.manifest);
  await writePublished(config.publishedPath, result.manifest, deps.storage);

  const at = deps.now().toISOString();
  console.log(
    `[${at}] age-out: ${result.dropped.length} dropped ` +
      `(${result.deleteAttempted.length} with stored images deleted), ` +
      `maxAgeHours=${config.maxAgeHours} opinionMaxAgeHours=${config.opinionMaxAgeHours}`,
  );
  for (const id of result.dropped) {
    console.log(`  • dropped ${id}`);
  }
}

main().catch((err) => {
  console.error("age-out failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
