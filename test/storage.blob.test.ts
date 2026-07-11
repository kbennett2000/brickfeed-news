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

describe("BlobStorageProvider.exists — HEAD the exact stored URL", () => {
  it("returns true on a 200 HEAD of a URL under the store host", async () => {
    const runner = fakeStorageRunner({ routes: { [`HEAD ${PUBLIC_URL}`]: { ok: true, status: 200 } } });
    expect(await provider(runner).exists(ID, PUBLIC_URL)).toBe(true);
    expect(runner.calls[0].method).toBe("HEAD");
    expect(runner.calls[0].url).toBe(PUBLIC_URL);
  });

  it("returns false on a 404 HEAD", async () => {
    const runner = fakeStorageRunner({ routes: { [`HEAD ${PUBLIC_URL}`]: { ok: false, status: 404 } } });
    expect(await provider(runner).exists(ID, PUBLIC_URL)).toBe(false);
  });

  it("short-circuits a stale/foreign/relative URL to false WITHOUT any request", async () => {
    const runner = fakeStorageRunner({ routes: { [`HEAD ${PUBLIC_URL}`]: { ok: true, status: 200 } } });
    // A relative local-scheme URL (e.g. after a provider switch) can't be an object here.
    expect(await provider(runner).exists(ID, "images/abc123.png")).toBe(false);
    expect(await provider(runner).exists(ID, "https://other.example.com/x.png")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("with no imageUrl, HEADs the deterministic default key", async () => {
    const runner = fakeStorageRunner({ routes: { [`HEAD ${PUBLIC_URL}`]: { ok: true, status: 200 } } });
    expect(await provider(runner).exists(ID)).toBe(true);
    expect(runner.calls[0].url).toBe(PUBLIC_URL); // images/abc123.png under the store host
  });

  it("is never-throw: a throwing runner yields false", async () => {
    const runner = fakeStorageRunner({ throws: true });
    expect(await provider(runner).exists(ID, PUBLIC_URL)).toBe(false);
  });
});

describe("BlobStorageProvider.preflight — deterministic, fail-loud, non-interactive", () => {
  const runner = fakeStorageRunner({});

  it("is ok when the token (env) and publicBaseUrl (config) are both present", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    expect(await provider(runner).preflight()).toEqual({ ok: true });
  });

  it("fails naming BLOB_READ_WRITE_TOKEN when the token is missing", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const result = await provider(runner).preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("BLOB_READ_WRITE_TOKEN");
  });

  it("fails naming storage.blob.publicBaseUrl when the URL is empty", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const p = new BlobStorageProvider({ pathPrefix: PREFIX, publicBaseUrl: "", runner });
    const result = await p.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("storage.blob.publicBaseUrl");
  });

  it("names BOTH when token and URL are missing", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const p = new BlobStorageProvider({ pathPrefix: PREFIX, publicBaseUrl: "", runner });
    const result = await p.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("BLOB_READ_WRITE_TOKEN");
      expect(result.message).toContain("storage.blob.publicBaseUrl");
    }
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
