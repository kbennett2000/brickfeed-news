import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { renderSite } from "./render/index.js";
import type { ManifestRecord } from "./types.js";

/**
 * CLI entry for the static render pass (Slice 7). Loads config.json, reads the newest-first
 * published.json (the seam publish.ts writes), renders the cover page + per-section pages +
 * stylesheet, and writes them under config.render.outputDir. Reads no environment (the
 * secrets guardrail confines env reads to secrets.ts; the renderer needs none). Mirrors
 * the other CLIs.
 *
 * A missing/empty published.json is not an error — it renders a valid empty-state page.
 *
 * Usage: `npm run render`.
 */
async function readPublished(path: string): Promise<ManifestRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.warn(`published.json not found at ${path}; rendering an empty page.`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ManifestRecord[]) : [];
  } catch {
    console.warn(`published.json at ${path} is not valid JSON; rendering an empty page.`);
    return [];
  }
}

async function main(): Promise<void> {
  const config = await loadConfig("config.json");
  const records = await readPublished(config.publishedPath);

  const files = renderSite(records, {
    now: new Date(),
    secondaryStoryCount: config.render.secondaryStoryCount,
    timeZone: config.render.timeZone,
  });

  await mkdir(config.render.outputDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(config.render.outputDir, name), contents, "utf8");
  }

  const at = new Date().toISOString();
  console.log(
    `[${at}] render: ${records.length} stories → ${Object.keys(files).length} files ` +
      `in ${config.render.outputDir}/ (secondaryStoryCount=${config.render.secondaryStoryCount})`,
  );
}

main().catch((err) => {
  console.error("render failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
