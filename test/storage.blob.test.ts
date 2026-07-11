import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobStorageProvider, extForContentType, storageKey } from "../src/storage/blob.js";
import { bytes, fakeStorageRunner } from "./helpers.js";

const PREFIX = "images/";
const PUBLIC_BASE = "https://store.test.public.blob.vercel-storage.com";
const ID = "abc123";
const KEY = `${PREFIX}${ID}.png`;
const PUT_URL = `https://blob.vercel-storage.com/${KEY}`;
const DELETE_URL = "https://blob.vercel-storage.com/delete";
const PUBLIC_URL = `${PUBLIC_BASE}/${KEY}`;
const PNG = bytes("\x89PNG...fake...");

function provider(runner: ReturnType<typeof fakeStorageRunner>): BlobStorageProvider {
  return new BlobStorageProvider({ pathPrefix: PREFIX, publicBaseUrl: PUBLIC_BASE, runner });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BlobStorageProvider.put", () => {
  it("uploads the bytes and returns the deterministic durable URL", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const runner = fakeStorageRunner({ routes: { [`PUT ${PUT_URL}`]: { ok: true } } });

    const url = await provider(runner).put(ID, PNG, "image/png");
    expect(url).toBe(PUBLIC_URL);

    const call = runner.calls[0];
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(PUT_URL);
    expect(call.headers?.authorization).toBe("Bearer test-token");
    expect(call.headers?.["x-add-random-suffix"]).toBe("0"); // deterministic/overwrite
    expect(call.headers?.["x-content-type"]).toBe("image/png");
    expect(call.body).toBe(PNG);
  });

  it("returns null (no request) when the token is missing", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const runner = fakeStorageRunner({ routes: { [`PUT ${PUT_URL}`]: { ok: true } } });
    expect(await provider(runner).put(ID, PNG, "image/png")).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("returns null on a non-2xx upload", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const runner = fakeStorageRunner({ routes: { [`PUT ${PUT_URL}`]: { ok: false, status: 500 } } });
    expect(await provider(runner).put(ID, PNG, "image/png")).toBeNull();
  });

  it("returns null when the runner throws (transport failure)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const runner = fakeStorageRunner({ throws: true });
    expect(await provider(runner).put(ID, PNG, "image/png")).toBeNull();
  });
});

describe("BlobStorageProvider.delete", () => {
  it("POSTs a delete for every candidate extension (id-only ⇒ can't know the stored ext)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const runner = fakeStorageRunner({ routes: { [`POST ${DELETE_URL}`]: { ok: true } } });

    await provider(runner).delete(ID);

    const call = runner.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(DELETE_URL);
    expect(call.headers?.authorization).toBe("Bearer test-token");
    // All extensions put can produce, so a .jpg image is removed, not orphaned.
    expect(JSON.parse(call.body as string)).toEqual({
      urls: [
        `${PUBLIC_BASE}/${PREFIX}${ID}.png`,
        `${PUBLIC_BASE}/${PREFIX}${ID}.jpg`,
        `${PUBLIC_BASE}/${PREFIX}${ID}.webp`,
      ],
    });
  });

  it("is non-fatal: a delete failure does not throw", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const runner = fakeStorageRunner({ routes: { [`POST ${DELETE_URL}`]: { ok: false, status: 500 } } });
    await expect(provider(runner).delete(ID)).resolves.toBeUndefined();
  });

  it("is non-fatal: a throwing runner does not propagate", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const runner = fakeStorageRunner({ throws: true });
    await expect(provider(runner).delete(ID)).resolves.toBeUndefined();
  });

  it("skips (no request) when the token is missing", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const runner = fakeStorageRunner({ routes: { [`POST ${DELETE_URL}`]: { ok: true } } });
    await provider(runner).delete(ID);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("storage key helpers", () => {
  it("builds a deterministic key from prefix + id + extension", () => {
    expect(storageKey("images/", "xyz", "image/png")).toBe("images/xyz.png");
    expect(storageKey("images/", "xyz", "image/jpeg")).toBe("images/xyz.jpg");
  });

  it("maps content-types to extensions, defaulting to .png", () => {
    expect(extForContentType("image/png")).toBe(".png");
    expect(extForContentType("image/jpeg")).toBe(".jpg");
    expect(extForContentType("image/webp")).toBe(".webp");
    expect(extForContentType("application/octet-stream")).toBe(".png");
  });
});
