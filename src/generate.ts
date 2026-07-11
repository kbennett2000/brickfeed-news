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

  // Select pending records in manifest order, capped by opts.limit. Already-generated
  // records are counted as skipped and never consume the attempt budget.
  let skipped = 0;
  const eligible: string[] = [];
  for (const id of Object.keys(manifest.stories)) {
    if (isGenerated(manifest.stories[id])) {
      skipped++;
      continue;
    }
    if (opts.limit != null && eligible.length >= opts.limit) continue;
    eligible.push(id);
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
