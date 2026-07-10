import type { Config } from "../config.js";
import { getBlobReadWriteToken } from "../secrets.js";
import type { StorageFs, StorageHttpRunner, StorageProvider } from "../types.js";
import { BlobStorageProvider } from "./blob.js";
import { LocalStorageProvider } from "./local.js";

export { BlobStorageProvider } from "./blob.js";
export { LocalStorageProvider } from "./local.js";

/**
 * Select a StorageProvider from config (Slice 4). Default is "blob" (Vercel Blob).
 * "local" writes to a directory served over LAN. A custom HTTP runner (blob) or FS
 * boundary (local) can be injected for tests; production leaves them undefined so the
 * real boundaries are used. Mirrors createImageProvider / createGenerator.
 */
export function createStorageProvider(
  config: Config,
  opts: { runner?: StorageHttpRunner; fs?: StorageFs } = {},
): StorageProvider {
  const { provider, blob, local } = config.storage;

  if (provider === "local") {
    return new LocalStorageProvider({
      dir: local.dir,
      publicBaseUrl: local.publicBaseUrl,
      fs: opts.fs,
    });
  }

  // Default: Vercel Blob. Advisory preflight only — a missing token fails safe (put
  // returns null so the story stays unpublished) rather than crashing the run.
  if (!getBlobReadWriteToken()) {
    console.warn(
      "warning: BLOB_READ_WRITE_TOKEN is not set; Blob storage will skip every story " +
        "(they stay unpublished). Set BLOB_READ_WRITE_TOKEN to enable it.",
    );
  }
  return new BlobStorageProvider({
    pathPrefix: blob.pathPrefix,
    publicBaseUrl: blob.publicBaseUrl,
    runner: opts.runner,
  });
}
