import { loadConfig } from "./config.js";
import { generateImages } from "./image.js";
import { createImageProvider } from "./image/index.js";
import { readManifest, writeManifest } from "./manifest.js";
import { writePublished } from "./publish.js";
import { createStorageProvider } from "./storage/index.js";
import type { ImageDeps } from "./types.js";

/**
 * CLI entry for the image pass (Slice 4). Loads config.json, reads the manifest, and for
 * every record with a wrappedPrompt and no imageUrl yet: generates image bytes, stores
 * them durably, and persists the returned URL back onto the record. Then persists the
 * manifest and writes the derived newest-first published.json. Mirrors src/generate-cli.ts.
 *
 * Replaces Slice 3's temporary out/<id>.png sink with real storage + manifest write-back.
 *
 * Usage: `npm run images` or `npm run images -- --limit 3` to cap how many eligible
 * stories are attempted this run (keeps live/GPU/upload usage small).
 */
async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));

  const config = await loadConfig("config.json");
  const startingManifest = await readManifest(config.manifestPath);

  const deps: ImageDeps = {
    provider: createImageProvider(config),
    storage: createStorageProvider(config),
    now: () => new Date(),
  };

  const result = await generateImages(config, startingManifest, deps, { limit });
  await writeManifest(config.manifestPath, result.manifest);
  await writePublished(config.publishedPath, result.manifest);

  const at = deps.now().toISOString();
  console.log(
    `[${at}] images: ${result.stored.length} stored, ` +
      `${result.skipped} skipped (already stored / no prompt), ${result.failed} failed`,
  );
  for (const id of result.stored) {
    console.log(`  • ${id} → ${result.manifest.stories[id].imageUrl}`);
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
  console.error("image generation failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
