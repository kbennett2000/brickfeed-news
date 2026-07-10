import type { Config } from "./config.js";
import type { ImageDeps, Manifest } from "./types.js";

export interface ImageResult {
  /** Story IDs whose image bytes were generated and written this run. */
  written: string[];
  /** Records skipped because they have no wrappedPrompt (not yet generated). */
  skipped: number;
  /** Records attempted but left without an image (provider/write returned null/threw). */
  failed: number;
}

/**
 * Image pass (Slice 3): for each manifest record that HAS a wrappedPrompt, ask the
 * ImageProvider for image bytes and hand them to the injected `writeImage` sink
 * (out/<id>.png this slice). Pure: the provider, writer, and clock are supplied by
 * the caller so this runs hermetically in tests.
 *
 * Guarantees:
 *  - Records without a wrappedPrompt are skipped; the provider is not called.
 *  - Resilient: a null/throwing provider (or a failed write) leaves that record
 *    without an image and the run continues with the remaining records.
 *  - opts.limit caps how many wrappedPrompt records are ATTEMPTED (keeps live runs
 *    cheap), matching generateAll's semantics.
 *
 * NOTE: Slice 3 has no per-record "already has an image" signal — that's a Slice 4
 * manifest field — so every wrappedPrompt record is (re)rendered each run, capped by
 * opts.limit. This is a temporary inspection sink, not the final publish path.
 */
export async function generateImages(
  _config: Config,
  manifest: Manifest,
  deps: ImageDeps,
  opts: { limit?: number } = {},
): Promise<ImageResult> {
  const written: string[] = [];
  let skipped = 0;
  let failed = 0;
  let attempted = 0;

  for (const id of Object.keys(manifest.stories)) {
    const record = manifest.stories[id];

    if (!record.wrappedPrompt) {
      skipped++; // not generated yet — nothing to render
      continue;
    }

    if (opts.limit != null && attempted >= opts.limit) {
      // Beyond the attempt cap: leave remaining renderable records untouched.
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

    try {
      await deps.writeImage(record.id, bytes);
    } catch {
      failed++; // bytes arrived but the sink failed — leave it for next run
      continue;
    }

    written.push(record.id);
  }

  return { written, skipped, failed };
}
