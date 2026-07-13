import { loadConfig } from "./config.js";
import { detectImageContentType } from "./image.js";
import { readManifest, writeManifest } from "./manifest.js";
import { mapWithConcurrency } from "./pool.js";
import { writePublished } from "./publish.js";
import { createStorageProvider } from "./storage/index.js";

/**
 * One-shot backfill: re-store every already-imaged story through the optimizing storage
 * pipeline (downscale + WebP), so the bandwidth win lands immediately on the current cover
 * rather than waiting for stories to age out and be replaced.
 *
 * Story images are idempotent (a record with an imageUrl is never re-uploaded by the cycle),
 * so without this they'd only convert as they roll over. Here we fetch each stored image's
 * current bytes, put them back through `createStorageProvider` (which wraps in the optimizer
 * when image.optimize.enabled), and rewrite the record's imageUrl/imageStoredAt to the new
 * `.webp` URL. A `.jpg`/`.png` predecessor simply orphans in Blob and is cleaned up when the
 * story ages out (delete targets every extension) — so no risky delete-before-write ordering.
 *
 * NEVER destructive: a fetch/optimize/put miss leaves that record's URL untouched (it stays
 * published on its old object) and is logged. Ads/articles need no backfill — they re-derive
 * from assets/ and re-upload optimized on the next render.
 *
 * Requires BLOB_READ_WRITE_TOKEN in the env (source cron.env first). Usage: `npm run backfill-optimize`.
 */
async function main(): Promise<void> {
  const config = await loadConfig("config.json");

  if (!config.image.optimize.enabled) {
    console.log("backfill: image.optimize.enabled is false — nothing to do.");
    return;
  }

  const storage = createStorageProvider(config);
  const preflight = await storage.preflight();
  if (!preflight.ok) {
    console.error(`backfill: ${preflight.message}`);
    process.exitCode = 1;
    return;
  }

  const manifest = await readManifest(config.manifestPath);
  const ids = Object.keys(manifest.stories).filter((id) => !!manifest.stories[id].imageUrl);
  console.log(
    `backfill: ${ids.length} imaged stor${ids.length === 1 ? "y" : "ies"} to re-optimize ` +
      `(maxEdge=${config.image.optimize.maxEdge}, quality=${config.image.optimize.quality}).`,
  );

  let converted = 0;
  let unchanged = 0;
  let failed = 0;

  const results = await mapWithConcurrency(ids, config.concurrency, async (id, i) => {
    const rec = manifest.stories[id];
    const oldUrl = rec.imageUrl as string;
    try {
      const resp = await fetch(oldUrl);
      if (!resp.ok) {
        console.warn(`backfill ${i + 1}/${ids.length} ${id}: fetch ${resp.status} — skipped`);
        return { id, url: null as string | null, storedAt: null as string | null };
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      // The wrapped storage optimizes on put; contentType here is only a fallback if the
      // optimizer degrades to passthrough, so sniff the real bytes.
      const url = await storage.put(id, bytes, detectImageContentType(bytes));
      if (!url) {
        console.warn(`backfill ${i + 1}/${ids.length} ${id}: put failed — kept old image`);
        return { id, url: null, storedAt: null };
      }
      const label = url === oldUrl ? "re-encoded in place" : `→ ${url.split("/").pop()}`;
      console.log(`backfill ${i + 1}/${ids.length} ${id}: ok (${label})`);
      return { id, url, storedAt: new Date().toISOString() as string | null };
    } catch (err) {
      console.warn(
        `backfill ${i + 1}/${ids.length} ${id}: ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      return { id, url: null, storedAt: null };
    }
  });

  for (const { id, url, storedAt } of results) {
    if (url == null || storedAt == null) {
      failed++;
      continue;
    }
    if (url === manifest.stories[id].imageUrl) {
      unchanged++;
    } else {
      converted++;
    }
    manifest.stories[id] = { ...manifest.stories[id], imageUrl: url, imageStoredAt: storedAt };
  }

  await writeManifest(config.manifestPath, manifest);
  // Refresh published.json so the next render emits the new .webp URLs (existence-verified).
  await writePublished(config.publishedPath, manifest, storage);

  console.log(
    `backfill: done — ${converted} converted, ${unchanged} re-encoded in place, ${failed} skipped. ` +
      `Manifest + published.json updated; run 'npm run render' to rebuild the site.`,
  );
}

main().catch((err) => {
  console.error("backfill failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
