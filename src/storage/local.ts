import { promises as nodeFs } from "node:fs";
import { basename, join } from "node:path";
import type { StorageFs, StorageProvider } from "../types.js";
import { extForContentType, IMAGE_FILE_EXTENSIONS } from "./blob.js";

/**
 * Local storage provider — the switchable alternative to Vercel Blob, and the keyless
 * path. Writes image bytes into a configured directory and returns a public URL formed
 * from a configured base URL + filename. The defaults put images INSIDE the render output
 * (`dir: site/images`, `publicBaseUrl: images`), so `put` returns the RELATIVE URL
 * `images/<id>.<ext>` — exactly what render emits as `<img src>` and what resolves under
 * the served site root (Vercel serves `site/` statically; the images ship with it).
 *
 * `put` writes atomically (temp file + rename, mirroring writeManifest) so a crash
 * mid-write can't leave a half-written image, and derives the file extension from the
 * content-type so a JPEG isn't misnamed `.png`. NEVER THROWS: any FS error returns null
 * so the story stays unpublished. `delete` unlinks the stored file for real — trying every
 * extension put can produce, since it only gets the id; a missing file or any other error
 * is non-fatal (logged), so age-out can always drop the record.
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
    // delete() gets only the id, not the stored content-type, so try every extension put
    // can produce and remove whichever file actually exists (grok stores .jpg). A missing
    // candidate (ENOENT) is expected and silent; any other error is non-fatal (logged).
    for (const ext of IMAGE_FILE_EXTENSIONS) {
      const path = join(this.dir, `${id}${ext}`);
      try {
        await this.fs.unlink(path);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          console.warn(
            `local delete failed for ${id}${ext}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  async exists(id: string, imageUrl?: string): Promise<boolean> {
    // Candidate filenames: the exact stored file named by the URL if known, else every
    // extension put can produce. Present AND non-zero on disk = a resolvable <img src>.
    const names = imageUrl
      ? [basename(imageUrl)]
      : IMAGE_FILE_EXTENSIONS.map((ext) => `${id}${ext}`);
    for (const name of names) {
      try {
        const st = await this.fs.stat(join(this.dir, name));
        if (st.size > 0) return true;
      } catch {
        // Missing / unreadable candidate — try the next one; any error means "not present".
      }
    }
    return false;
  }

  async preflight(): Promise<{ ok: true } | { ok: false; message: string }> {
    // Prove the dir is writable up front (create it, write+remove a probe) so a run never
    // discovers it can't store AFTER generating images. Never interactive.
    const probe = join(this.dir, ".brickfeed-preflight");
    try {
      await this.fs.mkdir(this.dir, { recursive: true });
      await this.fs.writeFile(probe, new Uint8Array(0));
      await this.fs.unlink(probe);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message:
          `storage preflight FAILED: provider "local" cannot write to storage.local.dir ` +
          `"${this.dir}" (${err instanceof Error ? err.message : String(err)}). Create the ` +
          `directory or fix its permissions, or set storage.local.dir in config.json. ` +
          `Aborting before generating images.`,
      };
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
  stat: (path) => nodeFs.stat(path),
};
