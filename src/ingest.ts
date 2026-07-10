import type { Config } from "./config.js";
import { storyId } from "./id.js";
import { fetchFeed } from "./rss.js";
import { resolveUrl, DEFAULT_RESOLVE_TIMEOUT_MS } from "./resolve.js";
import type { IngestDeps, Manifest, ManifestRecord } from "./types.js";

export interface IngestResult {
  /** Stories unseen before this run (freshly added to the manifest). */
  newStories: ManifestRecord[];
  /** Count of already-known stories whose lastSeen was refreshed this run. */
  knownCount: number;
  /** The updated manifest (caller decides when/whether to persist it). */
  manifest: Manifest;
}

/**
 * Core pipeline for Slice 1: fetch → resolve → identity → dedup against manifest.
 *
 * Given a starting manifest and the fetched feeds, classify each story as NEW
 * (unseen ID → added) or KNOWN (seen ID → lastSeen refreshed). Returns the NEW
 * stories. Reading/writing the manifest from disk is the caller's job (index.ts),
 * keeping this function pure and easy to test with an in-memory manifest.
 */
export async function ingest(
  config: Config,
  startingManifest: Manifest,
  deps: IngestDeps,
): Promise<IngestResult> {
  const nowIso = deps.now().toISOString();
  const timeoutMs = deps.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;

  // Fetch + merge every configured feed into one story list.
  const merged = (
    await Promise.all(config.feedUrls.map((url) => fetchFeed(url, deps.fetch)))
  ).flat();

  const manifest: Manifest = {
    version: startingManifest.version,
    stories: { ...startingManifest.stories },
  };
  const newStories: ManifestRecord[] = [];
  let knownCount = 0;
  // Track IDs already handled this run so a duplicate within the same run isn't
  // counted twice (it still refreshes lastSeen, just once toward the tally).
  const seenThisRun = new Set<string>();

  for (const item of merged) {
    const resolvedUrl = await resolveUrl(item.link, deps.fetch, timeoutMs);
    const id = storyId(resolvedUrl);

    const existing = manifest.stories[id];
    if (existing) {
      existing.lastSeen = nowIso;
      // Only tally as KNOWN once, and only if not already handled this run.
      if (!seenThisRun.has(id)) {
        knownCount++;
        seenThisRun.add(id);
      }
      continue;
    }

    const record: ManifestRecord = {
      id,
      url: resolvedUrl,
      title: item.title,
      sourceName: item.sourceName,
      firstSeen: nowIso,
      lastSeen: nowIso,
    };
    manifest.stories[id] = record;
    newStories.push(record);
    seenThisRun.add(id);
  }

  return { newStories, knownCount, manifest };
}
