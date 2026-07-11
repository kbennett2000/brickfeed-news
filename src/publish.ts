import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mapWithConcurrency } from "./pool.js";
import type { Manifest, ManifestRecord, StorageProvider } from "./types.js";

/** Bounded concurrency for the per-record image-existence checks (blob HEADs / local stats). */
const VERIFY_CONCURRENCY = 8;

/**
 * Image-gated publishing (ADR-0001 #4: "no story publishes without an image"). A record
 * is publishable only when it has headline, description, a durable imageUrl, and the
 * Slice 6 render fields category + caption — so partially-migrated (pre-Slice-6) records
 * never publish half-formed. Pure predicate — this is the seam the future render slice
 * consumes; nothing is rendered here.
 */
export function isPublishable(record: ManifestRecord): boolean {
  return (
    !!record.headline &&
    !!record.description &&
    !!record.imageUrl &&
    !!record.category &&
    !!record.caption
  );
}

/**
 * The publishable records, ordered newest-first by firstSeen. `firstSeen` is a stable
 * ISO timestamp, so a lexical (descending) compare is a correct chronological sort.
 * Returns a fresh array; the manifest is not mutated.
 */
export function publishableRecords(manifest: Manifest): ManifestRecord[] {
  return Object.values(manifest.stories)
    .filter(isPublishable)
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
}

/**
 * The publishable records that ALSO have a real, present image in `storage` — the
 * authoritative page source. Layered on the pure `isPublishable` field-gate because
 * existence is async and provider-specific (blob HEAD / local stat): a record whose
 * `imageUrl` is dangling (deleted, zero-length, or a stale scheme after a provider switch)
 * is excluded so no broken `<img>` ever renders. Preserves the newest-first order.
 */
export async function verifiedPublishableRecords(
  manifest: Manifest,
  storage: StorageProvider,
): Promise<ManifestRecord[]> {
  const candidates = publishableRecords(manifest);
  const present = await mapWithConcurrency(candidates, VERIFY_CONCURRENCY, (r) =>
    storage.exists(r.id, r.imageUrl),
  );
  return candidates.filter((_, i) => present[i]);
}

/**
 * Write the derived, newest-first published list to disk atomically (temp + rename,
 * mirroring writeManifest). This is the backend's final output seam for the render
 * slice — text-only JSON, not a rendered page. Each entry is a whole ManifestRecord,
 * so it carries the render fields (category + caption) the render slice consumes.
 *
 * When `storage` is passed, the list is existence-verified so published.json matches the
 * rendered page exactly; without it, it falls back to the pure field-gated list.
 */
export async function writePublished(
  path: string,
  manifest: Manifest,
  storage?: StorageProvider,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const records = storage
    ? await verifiedPublishableRecords(manifest, storage)
    : publishableRecords(manifest);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
