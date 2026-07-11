import type { Config } from "./config.js";
import { mapWithConcurrency } from "./pool.js";
import type { ImageDeps, Manifest, ManifestRecord } from "./types.js";

/** Content-type the pipeline stores images as (Grok Imagine / local imagegen return PNG). */
const IMAGE_CONTENT_TYPE = "image/png";

export interface ImageResult {
  /** Story IDs whose image was generated, stored, and persisted this run. */
  stored: string[];
  /** Records skipped: already have an image, or not yet generated (no wrappedPrompt). */
  skipped: number;
  /** Records attempted but left pending (generation or storage returned null/threw). */
  failed: number;
  /** The updated manifest (caller decides when/whether to persist it). */
  manifest: Manifest;
}

/**
 * A record has a durable image when its imageUrl is present. Because imageUrl +
 * imageStoredAt are written together (all-or-nothing) only after a successful store,
 * presence is a reliable idempotency signal — matching the generation layer's
 * isGenerated, no status flag.
 */
export function hasImage(record: ManifestRecord): boolean {
  return !!record.imageUrl;
}

/**
 * Image pass (Slice 4): the REAL gen → store → persist pipeline that replaces Slice 3's
 * out/ inspection sink. For each manifest record that HAS a wrappedPrompt and NO
 * imageUrl yet, ask the ImageProvider for bytes, hand them to the StorageProvider, and
 * on a durable URL write imageUrl + imageStoredAt back onto the record. Pure: provider,
 * storage, and clock are injected so this runs hermetically in tests.
 *
 * Guarantees:
 *  - Idempotent: a record that already has an imageUrl is skipped entirely — the
 *    provider is NOT called and storage is NOT touched (never re-pay, never re-upload).
 *  - Records without a wrappedPrompt are skipped (not generated yet).
 *  - All-or-nothing: imageUrl is written ONLY after a successful put. A null from the
 *    provider OR from storage leaves the record pending (imageUrl absent) — a story is
 *    NEVER persisted with a missing/half image.
 *  - Resilient: a null/throwing provider or a null from storage fails just that record;
 *    the run continues with the rest.
 *  - opts.limit caps how many eligible records are ATTEMPTED (keeps live runs cheap),
 *    matching generateAll's semantics.
 *  - opts.concurrency runs that many gen→store passes at once (each grok image call is
 *    ~90% idle waiting on the server). Default 1 (serial). Results apply in manifest
 *    order, so output is independent of finish order.
 *  - deps.log, when present, is called once per attempted story with progress + timing.
 */
export async function generateImages(
  _config: Config,
  startingManifest: Manifest,
  deps: ImageDeps,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<ImageResult> {
  const manifest: Manifest = {
    version: startingManifest.version,
    stories: { ...startingManifest.stories },
  };
  const log = deps.log ?? (() => {});

  // Select records that have a wrappedPrompt and no image yet, in manifest order, capped
  // by opts.limit. Already-stored and not-yet-generated records are skipped (not attempted).
  let skipped = 0;
  const eligible: string[] = [];
  for (const id of Object.keys(manifest.stories)) {
    const record = manifest.stories[id];
    if (hasImage(record) || !record.wrappedPrompt) {
      skipped++; // already stored (idempotent) or not generated yet — nothing to render
      continue;
    }
    if (opts.limit != null && eligible.length >= opts.limit) continue;
    eligible.push(id);
  }

  const total = eligible.length;
  const outcomes = await mapWithConcurrency(eligible, opts.concurrency ?? 1, async (id, i) => {
    const record = manifest.stories[id];
    const t0 = deps.now().getTime();

    let bytes;
    try {
      bytes = await deps.provider.generate(record.wrappedPrompt as string);
    } catch {
      // A provider should return null on failure, but treat any throw as a miss.
      bytes = null;
    }

    let url: string | null = null;
    if (bytes != null) {
      // Storage never throws (returns null on failure), but guard anyway.
      try {
        url = await deps.storage.put(record.id, bytes, IMAGE_CONTENT_TYPE);
      } catch {
        url = null;
      }
    }

    const secs = ((deps.now().getTime() - t0) / 1000).toFixed(1);
    if (url == null) {
      log(`image ${i + 1}/${total} ${id}: pending (${secs}s)`);
      return { id, url: null as string | null, storedAt: null as string | null };
    }
    log(`image ${i + 1}/${total} ${id}: ok (${secs}s)`);
    return { id, url, storedAt: deps.now().toISOString() as string | null };
  });

  // Apply in manifest (input) order so output is deterministic regardless of finish order.
  const stored: string[] = [];
  let failed = 0;
  for (const { id, url, storedAt } of outcomes) {
    if (url == null || storedAt == null) {
      failed++; // provider or storage failed — leave pending, retry next run
      continue;
    }
    manifest.stories[id] = { ...manifest.stories[id], imageUrl: url, imageStoredAt: storedAt };
    stored.push(id);
  }

  return { stored, skipped, failed, manifest };
}
