import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ADS_DIR, loadAds } from "./ads.js";
import { ARTICLES_DIR, loadArticles } from "./articles.js";
import { loadConfig } from "./config.js";
import { processHeadshots } from "./headshots.js";
import { loadPersonas } from "./personas.js";
import {
  buildAuthorDirectory,
  imageOptimizeOptionFromConfig,
  renderSite,
  staleColumnistPages,
  staleSectionPages,
} from "./render/index.js";
import { createStorageProvider } from "./storage/index.js";
import type { ManifestRecord } from "./types.js";

/**
 * CLI entry for the static render pass (Slice 7). Loads config.json, reads the newest-first
 * published.json (the seam publish.ts writes), renders the cover page + per-section pages +
 * stylesheet, and writes them under config.render.outputDir. Mirrors the other CLIs.
 *
 * Banner ads are uploaded here too (via the storage provider) so the local preview matches
 * production; that upload reads BLOB_READ_WRITE_TOKEN through secrets.ts. Without the token
 * the ad upload no-ops and the banner is omitted — the render itself needs no environment.
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

  // Banner ads: upload local ad images so the preview shows them. Without a storage token
  // put() returns null → ads is [] → the banner is simply omitted; the render still succeeds.
  const storage = createStorageProvider(config);
  // Persona headshots (ADR-0013 d.8): hash-gated, so the steady state is six hash checks.
  // Never throws; without a token put() returns null and the last-published avatars stay live.
  // The returned manifest feeds the opinion author directory (ADR-0016) below.
  const headshots = await processHeadshots(storage, {}, { log: console.warn });
  const ads = await loadAds(ADS_DIR, storage, { log: console.warn });
  // Locally hosted articles (ADR-0010): upload their images so the preview matches production.
  const articles = await loadArticles(ARTICLES_DIR, storage, { log: console.warn });
  // Opinion author directory (ADR-0016): persona display info + avatar URLs for byline rows.
  // loadPersonas is tolerant ([] on a missing dir); missing entries degrade with a warning.
  const personas = await loadPersonas(undefined, { log: console.warn });

  const files = renderSite(records, {
    now: new Date(),
    secondaryStoryCount: config.render.secondaryStoryCount,
    timeZone: config.render.timeZone,
    siteBaseUrl: config.render.siteBaseUrl,
    share: config.render.share,
    analytics: config.render.analytics,
    imageOptimize: imageOptimizeOptionFromConfig(config),
    ads,
    articles,
    authors: buildAuthorDirectory(personas, headshots.manifest),
    log: console.warn,
  });

  await mkdir(config.render.outputDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const dest = join(config.render.outputDir, name);
    // Per-story landing pages live under s/, so ensure each file's parent dir exists.
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, contents, "utf8");
  }
  // Empty sections emit no page (ADR-0013) — remove any stale one a previous render wrote,
  // or the deploy keeps serving it.
  for (const stale of staleSectionPages(files)) {
    await rm(join(config.render.outputDir, stale), { force: true });
  }
  // Retired personas leave stale bio pages (ADR-0019): the file map can't see a roster
  // removal, so list columnist/ (missing dir → none) and delete what this render didn't emit.
  const existingColumnist = await readdir(join(config.render.outputDir, "columnist")).catch(
    () => [] as string[],
  );
  for (const stale of staleColumnistPages(existingColumnist, files)) {
    await rm(join(config.render.outputDir, stale), { force: true });
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
