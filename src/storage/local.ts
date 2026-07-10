import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import type { StorageFs, StorageProvider } from "../types.js";
import { extForContentType } from "./blob.js";

/**
 * Local storage provider — the switchable alternative to Vercel Blob, for LAN /
 * self-hosted serving. Writes image bytes into a configured directory and returns a
 * public URL formed from a configured base URL + filename (whatever process serves
 * `dir` at `publicBaseUrl`).
 *
 * `put` writes atomically (temp file + rename, mirroring writeManifest) so a crash
 * mid-write can't leave a half-written image. NEVER THROWS: any FS error returns null
 * so the story stays unpublished. `delete` unlinks the file; a missing file or any
 * other error is non-fatal (logged), so age-out can always drop the record.
 *
 * The filesystem boundary is injected (defaults to node:fs/promises) so tests can drive
 * failure paths without a real disk; happy-path round-trips use a real temp dir.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly dir: string;
  private readonly publicBaseUrl: string;
  private readonly fs: StorageFs;

  constructor(opts: { dir: string; publicBaseUrl: string; fs?: StorageFs }) {
    this.dir = opts.dir;
    this.publicBaseUrl = opts.publicBaseUrl;
    this.fs = opts.fs ?? defaultStorageFs;
  }

  async put(id: string, bytes: Uint8Array, contentType: string): Promise<string | null> {
    const filename = `${id}${extForContentType(contentType)}`;
    const path = join(this.dir, filename);
    const tmp = `${path}.tmp`;
    try {
      await this.fs.mkdir(this.dir, { recursive: true });
      await this.fs.writeFile(tmp, bytes);
      await this.fs.rename(tmp, path);
      return `${trimTrailingSlash(this.publicBaseUrl)}/${filename}`;
    } catch {
      return null; // fail safe — story stays unpublished
    }
  }

  async delete(id: string): Promise<void> {
    // Reconstruct the default (.png) filename — the orchestrator stores png images.
    const filename = `${id}${extForContentType("image/png")}`;
    const path = join(this.dir, filename);
    try {
      await this.fs.unlink(path);
    } catch (err) {
      // Missing file (already gone) or any other error is non-fatal.
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        console.warn(
          `local delete failed for ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Default FS boundary backed by node:fs/promises. */
export const defaultStorageFs: StorageFs = {
  mkdir: (dir, opts) => nodeFs.mkdir(dir, opts),
  writeFile: (path, data) => nodeFs.writeFile(path, data),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
};
