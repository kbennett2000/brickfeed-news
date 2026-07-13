import sharp from "sharp";
import { detectImageContentType } from "../image.js";

/** Tunables for the build-time image optimizer (config.image.optimize). */
export interface OptimizeOptions {
  /** Longest-edge cap in px; larger images are downscaled, smaller ones left as-is. */
  maxEdge: number;
  /** WebP quality (1–100). ~80 is a good size/quality balance for photographic art. */
  quality: number;
}

/** The optimized bytes plus the content-type to store them under. */
export interface OptimizedImage {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Build-time image optimization: cap the longest edge at `maxEdge` (never enlarging) and
 * re-encode to WebP at `quality`. This is the single biggest bandwidth lever — story/ad/
 * article images are generated at 1024–1376 px and 0.3–2.2 MB, then displayed a few hundred
 * px wide; a capped WebP typically cuts 40–70% off the wire.
 *
 * NEVER THROWS — mirrors the provider/storage never-throw contract (src/types.ts). On ANY
 * failure (sharp can't decode the input, an unexpected error) it returns the ORIGINAL bytes
 * with their sniffed content-type, so a bad optimize degrades to "ship the original" and a
 * story is never dropped for an optimization error.
 */
export async function optimizeImage(
  bytes: Uint8Array,
  opts: OptimizeOptions,
): Promise<OptimizedImage> {
  try {
    const out = await sharp(bytes)
      .rotate() // honor EXIF orientation before we drop the metadata on re-encode
      .resize(opts.maxEdge, opts.maxEdge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toBuffer();
    return { bytes: new Uint8Array(out), contentType: "image/webp" };
  } catch {
    // Undecodable or any failure: pass the original through untouched (never-throw).
    return { bytes, contentType: detectImageContentType(bytes) };
  }
}
