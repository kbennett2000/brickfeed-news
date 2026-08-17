import { wrapBrickStyle } from "./brick.js";
import type { Config } from "./config.js";
import { mapWithConcurrency } from "./pool.js";
import type { GenerateDeps, Manifest, ManifestRecord } from "./types.js";

export interface GenerateResult {
  /** Records that gained generation content this run. */
  generated: ManifestRecord[];
  /** Records skipped because they were already generated (idempotent). */
  skipped: number;
  /** Records attempted but left pending (generator returned null / threw). */
  failed: number;
  /** The updated manifest (caller decides when/whether to persist it). */
  manifest: Manifest;
}

/**
 * A record is "generated" only when ALL six generation fields are present and
 * non-empty. Because we write them together (all-or-nothing), presence is a
 * reliable idempotency signal — matching Slice 1's presence-based dedup, no status
 * flag. A partially-populated record (should never happen) is treated as pending.
 *
 * category + caption were added in Slice 6, so a record generated BEFORE this slice
 * lacks them and is (correctly) treated as still-pending — it regenerates to backfill
 * the two new fields on the next run.
 */
export function isGenerated(record: ManifestRecord): boolean {
  return (
    !!record.headline &&
    !!record.description &&
    !!record.imagePrompt &&
    !!record.wrappedPrompt &&
    !!record.category &&
    !!record.caption
  );
}

/**
 * Generation pass (ADR decisions #6/#7): for each pending manifest record, ask the
 * Generator for {headline, description, imagePrompt, category, caption}, wrap the
 * neutral imagePrompt with the configured brick style, and write all six fields back
 * together. Pure:
 * the Generator, clock, and manifest are supplied by the caller so this runs
 * hermetically in tests.
 *
 * Guarantees:
 *  - Idempotent: already-generated records are skipped, the Generator is not called.
 *  - Never partial: a record is only mutated after a full successful output+wrap.
 *  - Resilient: a null/throwing generation leaves that record pending and the run
 *    continues with the remaining records.
 *  - opts.limit caps how many pending records are ATTEMPTED (keeps live runs cheap).
 *  - opts.concurrency runs that many generations at once (each grok call is ~90% idle
 *    waiting on the server, so a small pool collapses total wall-clock). Default 1
 *    (serial). Results are applied in manifest order, so output is independent of which
 *    task finishes first.
 *  - deps.log, when present, is called once per attempted story with progress + timing.
 */
export async function generateAll(
  config: Config,
  startingManifest: Manifest,
  deps: GenerateDeps,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<GenerateResult> {
  const manifest: Manifest = {
    version: startingManifest.version,
    stories: { ...startingManifest.stories },
  };
  const log = deps.log ?? (() => {});

  // Collect PENDING records NEWEST-first (by firstSeen desc). Already-generated and opinion
  // records are counted as skipped and never consume the attempt budget.
  const firstSeenOf = (id: string) => manifest.stories[id].firstSeen || "";
  let skipped = 0;
  const pending: string[] = [];
  const orderedIds = Object.keys(manifest.stories).sort((a, b) =>
    firstSeenOf(b).localeCompare(firstSeenOf(a)),
  );
  for (const id of orderedIds) {
    // Opinion pieces (ADR-0015) carry text but no image-prompt fields, so they read as
    // "pending" to isGenerated — without this exemption the story generator would
    // overwrite the piece with story-style output on the next cycle.
    if (manifest.stories[id].author) {
      skipped++;
      continue;
    }
    if (isGenerated(manifest.stories[id])) {
      skipped++;
      continue;
    }
    pending.push(id);
  }

  // Select up to opts.limit, reserving per-feed generation budget (ADR-0032 Layer B). Pure
  // newest-first (the historic behavior) drains the high-volume general firehose first, so
  // low-volume topic feeds (SPORTS, TECHNOLOGY, …) never get generated and their stories age
  // out un-categorized. A feed with `reserve: N` first claims up to N of its own newest pending
  // stories; the rest of the budget then fills newest-first across everything. With no reserves
  // configured this is exactly the old newest-first cap. No cap (limit==null) → generate all.
  const eligible = ((): string[] => {
    if (opts.limit == null) return pending;
    const limit = opts.limit;
    const reserves = new Map<string, number>();
    for (const feed of config.feeds) {
      if (feed.topic && feed.reserve > 0) {
        reserves.set(feed.topic, (reserves.get(feed.topic) ?? 0) + feed.reserve);
      }
    }
    const picked = new Set<string>();
    const selected: string[] = [];
    // Phase 1: satisfy each topic's reserve, newest-first within that topic.
    for (const [topic, reserve] of reserves) {
      let taken = 0;
      for (const id of pending) {
        if (selected.length >= limit || taken >= reserve) break;
        if (picked.has(id)) continue;
        if (manifest.stories[id].feedTopic === topic) {
          selected.push(id);
          picked.add(id);
          taken++;
        }
      }
      if (selected.length >= limit) break;
    }
    // Phase 2: fill the remaining budget newest-first across all still-pending stories.
    for (const id of pending) {
      if (selected.length >= limit) break;
      if (!picked.has(id)) {
        selected.push(id);
        picked.add(id);
      }
    }
    // Emit in newest-first order (a reserved older story sorts to the back) for stable output.
    return selected.sort((a, b) => firstSeenOf(b).localeCompare(firstSeenOf(a)));
  })();

  if (opts.limit != null && pending.length > eligible.length) {
    log(
      `generate: ${pending.length} pending, generating ${eligible.length} this run ` +
        `(${pending.length - eligible.length} deferred)`,
    );
  }

  const total = eligible.length;
  const outcomes = await mapWithConcurrency(eligible, opts.concurrency ?? 1, async (id, i) => {
    const record = manifest.stories[id];
    const t0 = deps.now().getTime();

    let output;
    try {
      output = await deps.generator.generate({
        title: record.title,
        sourceName: record.sourceName,
        url: record.url,
      });
    } catch {
      // A generator should return null on failure, but the apikey stub throws and
      // an impl could surprise us — treat any throw as a pending record.
      output = null;
    }

    const secs = ((deps.now().getTime() - t0) / 1000).toFixed(1);
    if (output == null) {
      log(`generate ${i + 1}/${total} ${id}: pending (${secs}s)`);
      return { id, updated: null as ManifestRecord | null };
    }

    // All-or-nothing write: build the fully-populated record.
    const updated: ManifestRecord = {
      ...record,
      headline: output.headline,
      description: output.description,
      imagePrompt: output.imagePrompt,
      wrappedPrompt: wrapBrickStyle(output.imagePrompt, config.brickStyle.styleLanguage),
      category: output.category,
      caption: output.caption,
    };
    log(`generate ${i + 1}/${total} ${id}: ok (${secs}s)`);
    return { id, updated };
  });

  // Apply in manifest (input) order so output is deterministic regardless of finish order.
  const generated: ManifestRecord[] = [];
  let failed = 0;
  for (const { id, updated } of outcomes) {
    if (updated == null) {
      failed++;
      continue; // leave the record pending; retried next run
    }
    manifest.stories[id] = updated;
    generated.push(updated);
  }

  return { generated, skipped, failed, manifest };
}
