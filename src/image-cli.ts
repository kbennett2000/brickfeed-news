import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { generateImages } from "./image.js";
import { createImageProvider } from "./image/index.js";
import { readManifest } from "./manifest.js";
import type { ImageDeps } from "./types.js";

/** Gitignored dir where image bytes land for visual inspection this slice. */
const OUT_DIR = "out";

/**
 * CLI entry for the image pass. Loads config.json, reads the manifest, generates
 * image bytes for every record that has a wrappedPrompt, and writes them to
 * out/<id>.png for visual inspection. Mirrors src/generate-cli.ts.
 *
 * This is a TEMPORARY sink (Slice 3) — Slice 4 replaces out/ with the storage
 * backend + manifest persistence. No manifest write-back here.
 *
 * Usage: `npm run images` or `npm run images -- --limit 3` to cap how many
 * renderable stories are attempted this run (keeps live/GPU usage small).
 */
async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));

  const config = await loadConfig("config.json");
  const manifest = await readManifest(config.manifestPath);

  const deps: ImageDeps = {
    provider: createImageProvider(config),
    writeImage: writeOutImage,
    now: () => new Date(),
  };

  const result = await generateImages(config, manifest, deps, { limit });

  const at = deps.now().toISOString();
  console.log(
    `[${at}] images: ${result.written.length} written, ` +
      `${result.skipped} skipped (no prompt), ${result.failed} failed`,
  );
  for (const id of result.written) {
    console.log(`  • ${join(OUT_DIR, `${id}.png`)}`);
  }
}

/** Write image bytes to out/<id>.png atomically (temp file + rename), mirroring writeManifest. */
async function writeOutImage(id: string, bytes: Uint8Array): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${id}.png`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
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
