import type { Config } from "./config.js";
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
 */
export async function generateImages(
  _config: Config,
  startingManifest: Manifest,
  deps: ImageDeps,
  opts: { limit?: number } = {},
): Promise<ImageResult> {
  const manifest: Manifest = {
    version: startingManifest.version,
    stories: { ...startingManifest.stories },
  };

  const stored: string[] = [];
  let skipped = 0;
  let failed = 0;
  let attempted = 0;

  for (const id of Object.keys(manifest.stories)) {
    const record = manifest.stories[id];

    if (hasImage(record)) {
      skipped++; // already stored — idempotent, never re-generate or re-upload
      continue;
    }

    if (!record.wrappedPrompt) {
      skipped++; // not generated yet — nothing to render
      continue;
    }

    if (opts.limit != null && attempted >= opts.limit) {
      // Beyond the attempt cap: leave remaining eligible records untouched.
      continue;
    }
    attempted++;

    let bytes;
    try {
      bytes = await deps.provider.generate(record.wrappedPrompt);
    } catch {
      // A provider should return null on failure, but treat any throw as a miss.
      bytes = null;
    }

    if (bytes == null) {
      failed++;
      continue; // no image this run; retried next run
    }

    // Storage never throws (returns null on failure), but guard anyway.
    let url: string | null;
    try {
      url = await deps.storage.put(record.id, bytes, IMAGE_CONTENT_TYPE);
    } catch {
      url = null;
    }

    if (url == null) {
      failed++; // bytes arrived but storage failed — leave pending, retry next run
      continue;
    }

    // All-or-nothing write: only now do we persist the image fields together.
    const updated: ManifestRecord = {
      ...record,
      imageUrl: url,
      imageStoredAt: deps.now().toISOString(),
    };
    manifest.stories[id] = updated;
    stored.push(record.id);
  }

  return { stored, skipped, failed, manifest };
}
