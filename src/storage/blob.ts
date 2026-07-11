import { getBlobReadWriteToken } from "../secrets.js";
import type { StorageHttpRunner, StorageProvider } from "../types.js";

/** Vercel Blob HTTP API host. Uploads PUT here; deletes POST to `${API_BASE}/delete`. */
const API_BASE = "https://blob.vercel-storage.com";
/** Pinned Blob API version (sent as `x-api-version`), matching the current REST contract. */
const API_VERSION = "7";

/**
 * Vercel Blob storage provider — the default. Persists image bytes with raw `fetch`
 * (no SDK, no new deps, matching the project's no-framework discipline) under a
 * DETERMINISTIC key derived from the story id, and returns a durable public CDN URL.
 *
 * The key is stable (`{pathPrefix}{id}{ext}`) and uploads set `x-add-random-suffix: 0`,
 * so re-storing the same story overwrites in place rather than accumulating copies —
 * safe to call again, though the orchestrator skips records that already have a URL.
 *
 * NEVER THROWS. `put` returns null on any failure (missing token, transport error,
 * non-2xx) so the story stays unpublished and is retried next run. `delete` swallows
 * every failure (logged, non-fatal) so age-out can always drop the record.
 *
 * Durable URLs and delete targets are built from `publicBaseUrl` (the store's public
 * host) — the same deterministic key both sides, so a later run/process can delete an
 * object it didn't upload. The low-level HTTP boundary is injected as a
 * StorageHttpRunner so tests exercise this hermetically without a token or network.
 */
export class BlobStorageProvider implements StorageProvider {
  private readonly pathPrefix: string;
  private readonly publicBaseUrl: string;
  private readonly runner: StorageHttpRunner;

  constructor(opts: {
    pathPrefix: string;
    publicBaseUrl: string;
    runner?: StorageHttpRunner;
  }) {
    this.pathPrefix = opts.pathPrefix;
    this.publicBaseUrl = opts.publicBaseUrl;
    this.runner = opts.runner ?? defaultStorageRunner;
  }

  async put(id: string, bytes: Uint8Array, contentType: string): Promise<string | null> {
    const token = getBlobReadWriteToken();
    if (!token) return null; // fail safe — story stays unpublished

    const key = storageKey(this.pathPrefix, id, contentType);
    try {
      const resp = await this.runner({
        url: `${API_BASE}/${key}`,
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "x-api-version": API_VERSION,
          "x-content-type": contentType,
          "x-add-random-suffix": "0",
        },
        body: bytes,
      });
      if (!resp.ok) return null;
      return this.publicUrl(key);
    } catch {
      return null; // transport or any other failure — never propagate
    }
  }

  async delete(id: string): Promise<void> {
    const token = getBlobReadWriteToken();
    if (!token) {
      console.warn(`blob delete skipped for ${id}: BLOB_READ_WRITE_TOKEN not set`);
      return;
    }

    // delete() gets only the id, not the stored content-type, so target every extension
    // put can produce — one delete request removes whichever object actually exists
    // (Blob ignores urls that aren't present), so a .jpg image is never orphaned.
    const urls = IMAGE_FILE_EXTENSIONS.map((ext) => this.publicUrl(`${this.pathPrefix}${id}${ext}`));
    try {
      const resp = await this.runner({
        url: `${API_BASE}/delete`,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-api-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ urls }),
      });
      if (!resp.ok) {
        console.warn(`blob delete failed for ${id}: status ${resp.status}`);
      }
    } catch (err) {
      console.warn(
        `blob delete failed for ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async exists(id: string, imageUrl?: string): Promise<boolean> {
    // Verify the EXACT URL render will emit. Only a URL that is absolute AND under this
    // store's public host can be an object here; a stale relative/foreign URL (e.g. after
    // a provider switch) is treated as not-present so the record is cleared and re-imaged.
    const base = trimTrailingSlash(this.publicBaseUrl);
    let target: string;
    if (imageUrl === undefined) {
      target = this.publicUrl(storageKey(this.pathPrefix, id, "image/png"));
    } else if (/^https?:\/\//i.test(imageUrl) && imageUrl.startsWith(`${base}/`)) {
      target = imageUrl;
    } else {
      return false;
    }
    try {
      const resp = await this.runner({ url: target, method: "HEAD", headers: {} });
      return resp.status === 200; // a stored Blob object is non-zero by construction
    } catch {
      return false; // transport or any other failure — never propagate
    }
  }

  async preflight(): Promise<{ ok: true } | { ok: false; message: string }> {
    const hasToken = !!getBlobReadWriteToken();
    const hasUrl = this.publicBaseUrl.trim() !== "";
    if (!hasToken && !hasUrl) {
      return {
        ok: false,
        message:
          'storage preflight FAILED: provider "blob" needs BOTH the BLOB_READ_WRITE_TOKEN ' +
          "environment variable (currently unset) and storage.blob.publicBaseUrl in config.json " +
          "(currently empty). Set the token (e.g. `export BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...`) " +
          'and the URL (e.g. "https://<store-id>.public.blob.vercel-storage.com"). ' +
          "Aborting before generating images.",
      };
    }
    if (!hasToken) {
      return {
        ok: false,
        message:
          'storage preflight FAILED: provider "blob" needs the BLOB_READ_WRITE_TOKEN ' +
          "environment variable (currently unset). Set it, e.g. " +
          "`export BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...`. Aborting before generating images.",
      };
    }
    if (!hasUrl) {
      return {
        ok: false,
        message:
          'storage preflight FAILED: provider "blob" needs storage.blob.publicBaseUrl in ' +
          'config.json (currently empty). Set it to your store host, e.g. ' +
          '"https://<store-id>.public.blob.vercel-storage.com". Aborting before generating images.',
      };
    }
    return { ok: true };
  }

  private publicUrl(key: string): string {
    return `${trimTrailingSlash(this.publicBaseUrl)}/${key}`;
  }
}

/** The object key for a story: `{pathPrefix}{id}{ext}`, extension chosen by contentType. */
export function storageKey(pathPrefix: string, id: string, contentType: string): string {
  return `${pathPrefix}${id}${extForContentType(contentType)}`;
}

/** Map an image content-type to a file extension. Defaults to .png. */
export function extForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("webp")) return ".webp";
  return ".png";
}

/**
 * Every extension `put` can produce (see extForContentType). `delete` only gets a story
 * id — not the content-type it was stored with — so it targets ALL candidates to remove
 * the real artifact regardless of which one was written (grok stores .jpg, older runs .png).
 */
export const IMAGE_FILE_EXTENSIONS = [".png", ".jpg", ".webp"] as const;

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Default runner: a thin raw-fetch wrapper returning the response status + body text.
 * A transport error resolves as ok:false so callers degrade to null / non-fatal rather
 * than throwing. No new runtime deps.
 */
export const defaultStorageRunner: StorageHttpRunner = async ({ url, method, headers, body }) => {
  try {
    const resp = await fetch(url, { method, headers, body });
    let text = "";
    try {
      text = await resp.text();
    } catch {
      text = "";
    }
    return { ok: resp.ok, status: resp.status, body: text };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
};
