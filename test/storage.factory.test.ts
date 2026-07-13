import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createStorageProvider, BlobStorageProvider, LocalStorageProvider } from "../src/storage/index.js";
import { detectImageContentType } from "../src/image.js";
import { fakeStorageFs, makeConfig } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createStorageProvider", () => {
  it("defaults to the Blob provider", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const provider = createStorageProvider(makeConfig());
    expect(provider).toBeInstanceOf(BlobStorageProvider);
  });

  it("returns the local provider when configured", () => {
    const config = makeConfig({
      storage: {
        provider: "local",
        blob: { pathPrefix: "images/", publicBaseUrl: "" },
        local: { dir: "/tmp/x", publicBaseUrl: "http://x/blob" },
      },
    });
    expect(createStorageProvider(config)).toBeInstanceOf(LocalStorageProvider);
  });

  it("does NOT warn or prompt when blob is selected without a token (preflight enforces it)", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = createStorageProvider(makeConfig());
    // Construction is silent — the hard, actionable check is BlobStorageProvider.preflight(),
    // called once up front by the cycle. The factory never warns and never prompts.
    expect(provider).toBeInstanceOf(BlobStorageProvider);
    expect(warn).not.toHaveBeenCalled();
  });

  it("wraps with the image optimizer when image.optimize.enabled — put stores a downscaled WebP", async () => {
    const fs = fakeStorageFs();
    const config = makeConfig({
      storage: {
        provider: "local",
        blob: { pathPrefix: "images/", publicBaseUrl: "" },
        local: { dir: "/imgs", publicBaseUrl: "images" },
      },
    });
    config.image.optimize = { enabled: true, maxEdge: 1280, quality: 80 };

    const provider = createStorageProvider(config, { fs });
    const png = new Uint8Array(
      await sharp({
        create: { width: 2000, height: 1500, channels: 3, background: { r: 10, g: 90, b: 200 } },
      })
        .png()
        .toBuffer(),
    );

    const url = await provider.put("story-1", png, "image/png");

    // The optimizer changed the content-type to WebP, so the stored key is .webp.
    expect(url).toBe("images/story-1.webp");
    const stored = fs.files.get("/imgs/story-1.webp");
    expect(stored).toBeDefined();
    expect(detectImageContentType(stored!)).toBe("image/webp");
    const meta = await sharp(stored!).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1280);
    expect(stored!.byteLength).toBeLessThan(png.byteLength);
  });
});
