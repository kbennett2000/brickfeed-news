import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { optimizeImage } from "../src/image/optimize.js";
import { detectImageContentType } from "../src/image.js";
import { withImageOptimization } from "../src/storage/optimizing.js";
import { fakeStorageProvider } from "./helpers.js";

/** Build a real PNG buffer of the given size, filled with a solid colour. */
async function makePng(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

/** WebP magic bytes: "RIFF" .... "WEBP". */
function isWebp(bytes: Uint8Array): boolean {
  return detectImageContentType(bytes) === "image/webp";
}

describe("optimizeImage", () => {
  it("downscales an oversized image to maxEdge and re-encodes to WebP, smaller than the source", async () => {
    const src = await makePng(2000, 1500); // larger than a 1280 cap
    const out = await optimizeImage(src, { maxEdge: 1280, quality: 80 });

    expect(out.contentType).toBe("image/webp");
    expect(isWebp(out.bytes)).toBe(true);

    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    // Longest edge capped; aspect ratio preserved (2000×1500 → 1280×960).
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1280);
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(960);
    // A solid-colour re-encode is tiny, but the point is it is not larger than the PNG source.
    expect(out.bytes.byteLength).toBeLessThan(src.byteLength);
  });

  it("does NOT enlarge an image already smaller than maxEdge", async () => {
    const src = await makePng(640, 480);
    const out = await optimizeImage(src, { maxEdge: 1280, quality: 80 });

    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it("passes non-image bytes through untouched (never-throw)", async () => {
    const junk = new TextEncoder().encode("not an image at all");
    const out = await optimizeImage(junk, { maxEdge: 1280, quality: 80 });

    expect(out.bytes).toBe(junk); // same reference — nothing re-encoded
    expect(out.contentType).toBe(detectImageContentType(junk)); // sniffed fallback (png)
  });
});

describe("withImageOptimization", () => {
  it("optimizes bytes before delegating put — underlying storage sees WebP", async () => {
    const inner = fakeStorageProvider();
    const wrapped = withImageOptimization(inner, { maxEdge: 1280, quality: 80 });
    const src = await makePng(2000, 1500);

    const url = await wrapped.put("story-1", src, "image/png");

    expect(inner.puts).toHaveLength(1);
    expect(inner.puts[0].id).toBe("story-1");
    expect(inner.puts[0].contentType).toBe("image/webp");
    expect(isWebp(inner.puts[0].bytes)).toBe(true);
    expect(inner.puts[0].bytes.byteLength).toBeLessThan(src.byteLength);
    // The URL is whatever the underlying provider returns — unchanged pass-through.
    expect(url).toBe("https://cdn.test/story-1.png");
  });

  it("delegates delete / exists / preflight unchanged", async () => {
    const inner = fakeStorageProvider();
    const wrapped = withImageOptimization(inner, { maxEdge: 1280, quality: 80 });

    await wrapped.delete("story-9");
    expect(inner.deletes).toEqual(["story-9"]);

    await wrapped.exists("story-9", "https://cdn.test/story-9.webp");
    expect(inner.existsCalls).toEqual(["story-9"]);

    expect(await wrapped.preflight()).toEqual({ ok: true });
  });
});
