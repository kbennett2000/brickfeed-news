import { optimizeImage, type OptimizeOptions } from "../image/optimize.js";
import type { StorageProvider } from "../types.js";

/**
 * Wrap a StorageProvider so every `put` first runs the bytes through the build-time image
 * optimizer (downscale + WebP re-encode) before they're persisted. This is the single
 * chokepoint all image bytes flow through — stories (image.ts), banner ads (ads.ts), and
 * local articles (articles.ts) all call `storage.put` — so one wrap optimizes them all
 * without touching those call sites.
 *
 * Only `put` is intercepted; `delete`/`exists`/`preflight` delegate unchanged. The optimizer
 * hands back `image/webp`, so the underlying provider stores under a `.webp` key (its
 * extForContentType already maps that) and returns an honest `.webp` URL. optimizeImage
 * never throws (it degrades to the original bytes), so wrapping never changes the provider's
 * never-throw contract.
 */
export function withImageOptimization(
  storage: StorageProvider,
  opts: OptimizeOptions,
): StorageProvider {
  return {
    // The incoming contentType is ignored: optimizeImage re-encodes to WebP (and sniffs the
    // bytes itself for its passthrough fallback), so it decides the stored type.
    async put(id: string, bytes: Uint8Array, _contentType: string): Promise<string | null> {
      const optimized = await optimizeImage(bytes, opts);
      return storage.put(id, optimized.bytes, optimized.contentType);
    },
    delete: (id) => storage.delete(id),
    exists: (id, imageUrl) => storage.exists(id, imageUrl),
    preflight: () => storage.preflight(),
  };
}
