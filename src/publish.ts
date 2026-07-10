import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Manifest, ManifestRecord } from "./types.js";

/**
 * Image-gated publishing (ADR-0001 #4: "no story publishes without an image"). A record
 * is publishable only when it has all three of headline, description, and a durable
 * imageUrl. Pure predicate — this is the seam the future render slice consumes; nothing
 * is rendered here.
 */
export function isPublishable(record: ManifestRecord): boolean {
  return !!record.headline && !!record.description && !!record.imageUrl;
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
 * Write the derived, newest-first published list to disk atomically (temp + rename,
 * mirroring writeManifest). This is the backend's final output seam for the render
 * slice — text-only JSON, not a rendered page.
 */
export async function writePublished(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const records = publishableRecords(manifest);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
