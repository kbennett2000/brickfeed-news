import type { Config } from "../config.js";
import type { StorageFs, StorageHttpRunner, StorageProvider } from "../types.js";
import { BlobStorageProvider } from "./blob.js";
import { LocalStorageProvider } from "./local.js";
import { withImageOptimization } from "./optimizing.js";

export { BlobStorageProvider } from "./blob.js";
export { LocalStorageProvider } from "./local.js";
export { withImageOptimization } from "./optimizing.js";

/**
 * Select a StorageProvider from config (Slice 4). Default is "blob" (Vercel Blob).
 * "local" writes to a directory served over LAN. A custom HTTP runner (blob) or FS
 * boundary (local) can be injected for tests; production leaves them undefined so the
 * real boundaries are used. Mirrors createImageProvider / createGenerator.
 *
 * When `image.optimize.enabled` (the default), the chosen provider is wrapped so every
 * stored image is downscaled + WebP-encoded first — one seam covers all four production
 * entrypoints (cycle, image, render, ageout) and thus stories, ads, and articles alike.
 */
export function createStorageProvider(
  config: Config,
  opts: { runner?: StorageHttpRunner; fs?: StorageFs } = {},
): StorageProvider {
  const { provider, blob, local } = config.storage;

  const base: StorageProvider =
    provider === "local"
      ? new LocalStorageProvider({
          dir: local.dir,
          publicBaseUrl: local.publicBaseUrl,
          fs: opts.fs,
        })
      : // Default: Vercel Blob. Preconditions (token + publicBaseUrl) are enforced up front by
        // BlobStorageProvider.preflight(), which the cycle calls before doing any work — so a
        // misconfigured run fails LOUD with an actionable message rather than silently.
        new BlobStorageProvider({
          pathPrefix: blob.pathPrefix,
          publicBaseUrl: blob.publicBaseUrl,
          runner: opts.runner,
        });

  const { enabled, maxEdge, quality } = config.image.optimize;
  return enabled ? withImageOptimization(base, { maxEdge, quality }) : base;
}
