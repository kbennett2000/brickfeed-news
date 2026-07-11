import type { Config } from "./config.js";
import { mapWithConcurrency } from "./pool.js";
import type { ImageDeps, Manifest, ManifestRecord } from "./types.js";

/**
 * Detect an image's content-type from its leading magic bytes. Grok Imagine emits JPEG;
 * local imagegen may emit PNG/WebP. Sniffing the bytes (rather than trusting a hardcoded
 * type) keeps the stored file's EXTENSION honest, so the served `<img>` and the delete-key
 * both match what was actually written. Unknown/short input falls back to PNG.
 */
export function detectImageContentType(bytes: Uint8Array): string {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png"; // unknown — default matches the historical assumption
}

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
 *  - Eligible records are ordered NEWEST-FIRST by firstSeen, then opts.limit caps how many
 *    are ATTEMPTED (keeps live runs cheap) — so the freshest stories are imaged first and a
 *    growing backlog can't starve today's news of a picture (and thus the lead).
 *  - opts.concurrency runs that many gen→store passes at once (each grok image call is
 *    ~90% idle waiting on the server). Default 1 (serial). Results apply in eligibility
 *    (newest-first) order, so output is independent of finish order.
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

  // Reconcile stale image references FIRST (owner decision: clear + re-image). A record
  // whose imageUrl no longer resolves in the CURRENT store — deleted, zero-length, or a
  // stale scheme after a provider switch (e.g. a local `images/…` URL under Blob) — has its
  // imageUrl cleared here, so the eligibility scan below re-images it into this store. A
  // record cleared but not re-imaged this run (beyond the cap) simply stays unpublished
  // (no dangling <img>) and retries next run.
  const withImage = Object.keys(manifest.stories).filter((id) => hasImage(manifest.stories[id]));
  const resolved = await mapWithConcurrency(withImage, opts.concurrency ?? 1, (id) =>
    deps.storage.exists(id, manifest.stories[id].imageUrl),
  );
  let recleared = 0;
  withImage.forEach((id, i) => {
    if (!resolved[i]) {
      const rec = { ...manifest.stories[id] };
      delete rec.imageUrl;
      delete rec.imageStoredAt;
      manifest.stories[id] = rec;
      recleared++;
    }
  });
  if (recleared > 0) {
    log(`image: recleared ${recleared} stale image reference(s) — will re-image this run`);
  }

  // Select records that have a wrappedPrompt and no image yet. Order them NEWEST-FIRST by
  // firstSeen (the same key the render sorts by, publish.ts) BEFORE applying opts.limit, so
  // the freshest stories get an image — and thus the lead — first. Imaging capacity is finite
  // (limit + provider throughput), and ingest can outpace it; ordering oldest-first would let
  // the imaging frontier crawl through stale stories while today's news never gets a picture.
  // Older un-imaged stragglers left beyond the cap simply age out unpublished (no dangling img).
  let skipped = 0;
  const candidates: string[] = [];
  for (const id of Object.keys(manifest.stories)) {
    const record = manifest.stories[id];
    if (hasImage(record) || !record.wrappedPrompt) {
      skipped++; // already stored (idempotent) or not generated yet — nothing to render
      continue;
    }
    candidates.push(id);
  }
  candidates.sort((a, b) =>
    manifest.stories[b].firstSeen.localeCompare(manifest.stories[a].firstSeen),
  );
  const eligible =
    opts.limit != null ? candidates.slice(0, opts.limit) : candidates;
  if (opts.limit != null && candidates.length > eligible.length) {
    log(
      `image: ${candidates.length} eligible, imaging the ${eligible.length} newest this run (${candidates.length - eligible.length} deferred)`,
    );
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
      // Storage never throws (returns null on failure), but guard anyway. The content-type
      // is sniffed from the bytes so the stored extension is correct (grok emits JPEG).
      try {
        url = await deps.storage.put(record.id, bytes, detectImageContentType(bytes));
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

  // Apply in eligibility (newest-first) order so output is deterministic regardless of finish order.
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
