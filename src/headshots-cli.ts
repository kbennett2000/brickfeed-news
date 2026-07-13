import { loadConfig } from "./config.js";
import { HEADSHOTS_MANIFEST_PATH, processHeadshots, summarizeHeadshots } from "./headshots.js";
import { createStorageProvider } from "./storage/index.js";

/**
 * CLI entry for the persona-headshot step (ADR-0013 decision 8): hash-gate each
 * `assets/headshots/<name>.png` against data/headshots.json, square-crop changed sources
 * to a 256×256 avatar, and publish through the same optimizing storage path story images
 * use. Both site writers auto-invoke this too — the standalone CLI exists for `--force`
 * (reprocess regardless of hash, e.g. after changing avatar size or optimize settings).
 *
 * Requires BLOB_READ_WRITE_TOKEN in the env (source cron.env first). Unlike the tolerant
 * in-cycle invocation, an explicit CLI run fails loud on a bad storage setup.
 *
 * Usage: `npm run headshots [-- --force]`.
 */
async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");
  const config = await loadConfig("config.json");

  const storage = createStorageProvider(config);
  const preflight = await storage.preflight();
  if (!preflight.ok) {
    console.error(`headshots: ${preflight.message}`);
    process.exitCode = 1;
    return;
  }

  const result = await processHeadshots(storage, { force }, { log: console.warn });
  const wrote = result.processed.length > 0 ? ` → ${HEADSHOTS_MANIFEST_PATH}` : "";
  console.log(`headshots: ${summarizeHeadshots(result)}${wrote}`);
}

main().catch((err) => {
  console.error("headshots failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
