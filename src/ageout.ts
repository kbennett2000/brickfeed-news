import type { Config } from "./config.js";
import type { Manifest, StorageProvider } from "./types.js";

export interface AgeOutResult {
  /** Story IDs dropped from the manifest this run. */
  dropped: string[];
  /** Dropped IDs whose stored image we attempted to delete (had an imageUrl). */
  deleteAttempted: string[];
  /** The updated manifest (caller decides when/whether to persist it). */
  manifest: Manifest;
}

export interface AgeOutDeps {
  storage: StorageProvider;
  /** Returns "now"; injected so tests can pin the clock. */
  now: () => Date;
}

/**
 * Age-out pass (ADR-0001 #4): records with no update older than config.maxAgeHours are
 * dropped from the manifest AND their stored image is deleted for real (images live in
 * storage, not git). Age is measured from lastSeen. Pure: storage + clock are injected.
 *
 * Guarantees:
 *  - A stale record is ALWAYS dropped, regardless of the delete outcome. StorageProvider
 *    .delete never throws and reports failures itself (logged, non-fatal); we do not
 *    tombstone or retry — a rare orphaned blob is an accepted trade for simplicity.
 *  - delete is only called for records that actually have a stored image (imageUrl).
 *  - Records within the window are kept untouched.
 */
export async function ageOut(
  config: Config,
  startingManifest: Manifest,
  deps: AgeOutDeps,
): Promise<AgeOutResult> {
  const manifest: Manifest = {
    version: startingManifest.version,
    stories: { ...startingManifest.stories },
  };

  const dropped: string[] = [];
  const deleteAttempted: string[] = [];
  const nowMs = deps.now().getTime();
  const maxAgeMs = config.maxAgeHours * 3600_000;

  for (const id of Object.keys(manifest.stories)) {
    const record = manifest.stories[id];
    const lastSeenMs = new Date(record.lastSeen).getTime();

    // Guard against an unparseable lastSeen (NaN): treat as not-stale, keep the record.
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs <= maxAgeMs) {
      continue;
    }

    // Drop first so a slow/failed delete can never block removal.
    delete manifest.stories[id];
    dropped.push(id);

    if (record.imageUrl) {
      deleteAttempted.push(id);
      // StorageProvider.delete is contractually never-throw, but guard anyway so a
      // misbehaving provider can never undo the drop we already committed.
      try {
        await deps.storage.delete(id);
      } catch {
        // non-fatal — the record is already dropped
      }
    }
  }

  return { dropped, deleteAttempted, manifest };
}
