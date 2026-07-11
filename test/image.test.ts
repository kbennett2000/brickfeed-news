import { describe, expect, it } from "vitest";
import { detectImageContentType, generateImages } from "../src/image.js";
import type { ImageDeps, Manifest, ManifestRecord } from "../src/types.js";
import { bytes, fakeImageProvider, fakeStorageProvider, fixedNow, makeConfig } from "./helpers.js";

const NOW = "2025-07-08T00:00:00.000Z";
const config = makeConfig();

/** A record that has been through generation (has a wrappedPrompt → eligible). */
function eligible(id: string): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Story ${id}`,
    sourceName: "Src",
    firstSeen: "2025-07-01T00:00:00.000Z",
    lastSeen: "2025-07-07T00:00:00.000Z",
    headline: `Headline ${id}`,
    description: "A description.",
    imagePrompt: "a scene",
    wrappedPrompt: `TEST-STYLE Scene: ${id}`,
  };
}

/** A pending record with no wrappedPrompt yet (not eligible). */
function pending(id: string): ManifestRecord {
  const r = eligible(id);
  delete r.headline;
  delete r.description;
  delete r.imagePrompt;
  delete r.wrappedPrompt;
  return r;
}

/** An already-stored record (has imageUrl) — must be skipped idempotently. */
function stored(id: string): ManifestRecord {
  return { ...eligible(id), imageUrl: `https://cdn.test/${id}.png`, imageStoredAt: NOW };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

function depsWith(
  provider: ImageDeps["provider"],
  storage: ImageDeps["storage"],
): ImageDeps {
  return { provider, storage, now: fixedNow(NOW) };
}

describe("generateImages", () => {
  it("generates, stores, and persists imageUrl + imageStoredAt for each eligible record", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.stored.sort()).toEqual(["a", "b"]);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(provider.calls.sort()).toEqual(["TEST-STYLE Scene: a", "TEST-STYLE Scene: b"]);
    expect(storage.puts.map((p) => p.id).sort()).toEqual(["a", "b"]);
    // The bytes handed to storage are the provider's output; content-type is png.
    expect(storage.puts[0].contentType).toBe("image/png");
    expect(storage.puts.find((p) => p.id === "a")!.bytes).toEqual(bytes("img:TEST-STYLE Scene: a"));
    // Persisted onto the (immutable copy) manifest record.
    expect(result.manifest.stories.a.imageUrl).toBe("https://cdn.test/a.png");
    expect(result.manifest.stories.a.imageStoredAt).toBe(NOW);
  });

  it("does not mutate the starting manifest", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"));

    await generateImages(config, manifest, depsWith(provider, storage));

    expect(manifest.stories.a.imageUrl).toBeUndefined();
  });

  it("hands storage the content-type sniffed from the bytes (grok emits JPEG)", async () => {
    // Real JPEG magic (FF D8 FF) → storage is told image/jpeg, so the file gets a .jpg name.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const provider = fakeImageProvider({ impl: () => jpeg });
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"));

    await generateImages(config, manifest, depsWith(provider, storage));

    expect(storage.puts[0].contentType).toBe("image/jpeg");
  });

  it("skips records without a wrappedPrompt and never calls the provider or storage", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(pending("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.skipped).toBe(1);
    expect(result.stored).toEqual(["b"]);
    expect(provider.calls).toEqual(["TEST-STYLE Scene: b"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["b"]);
  });

  it("is idempotent: a record with an imageUrl is skipped — neither generate nor put called", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(stored("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.skipped).toBe(1);
    expect(result.stored).toEqual(["b"]);
    // "a" was never regenerated or re-uploaded.
    expect(provider.calls).toEqual(["TEST-STYLE Scene: b"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["b"]);
    // Its existing URL is preserved untouched.
    expect(result.manifest.stories.a.imageUrl).toBe("https://cdn.test/a.png");
  });

  it("all-or-nothing: provider returns null → no put, no imageUrl, record stays pending", async () => {
    const provider = fakeImageProvider({
      impl: (p) => (p === "TEST-STYLE Scene: a" ? null : bytes(`img:${p}`)),
    });
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.failed).toBe(1);
    expect(result.stored).toEqual(["b"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["b"]); // "a" never reached storage
    expect(result.manifest.stories.a.imageUrl).toBeUndefined();
  });

  it("all-or-nothing: bytes ok but storage.put returns null → nothing persisted", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider({ put: (id) => (id === "a" ? null : `https://cdn.test/${id}.png`) });
    const manifest = manifestOf(eligible("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.failed).toBe(1);
    expect(result.stored).toEqual(["b"]);
    // put WAS attempted for "a" (bytes arrived) but no URL → no persistence.
    expect(storage.puts.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(result.manifest.stories.a.imageUrl).toBeUndefined();
    expect(result.manifest.stories.a.imageStoredAt).toBeUndefined();
  });

  it("is resilient: a provider that throws fails one record, the run continues", async () => {
    const provider = fakeImageProvider({ throwOn: new Set(["TEST-STYLE Scene: a"]) });
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.failed).toBe(1);
    expect(result.stored).toEqual(["b"]);
  });

  it("is resilient: a storage.put that throws fails one record, the run continues", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider({ throwOnPut: new Set(["a"]) });
    const manifest = manifestOf(eligible("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.failed).toBe(1);
    expect(result.stored).toEqual(["b"]);
    expect(result.manifest.stories.a.imageUrl).toBeUndefined();
  });

  it("caps attempts with opts.limit (eligible records beyond the cap untouched)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"), eligible("b"), eligible("c"));

    const result = await generateImages(config, manifest, depsWith(provider, storage), { limit: 2 });

    expect(provider.calls).toHaveLength(2);
    expect(result.stored).toHaveLength(2);
  });

  it("limit counts attempts, not skips (pending/stored records don't consume the budget)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(pending("p1"), stored("s1"), eligible("a"), eligible("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage), { limit: 1 });

    expect(result.skipped).toBe(2); // p1 (no prompt) + s1 (already stored)
    expect(provider.calls).toHaveLength(1);
    expect(result.stored).toHaveLength(1);
  });

  it("runs with concurrency, preserves manifest order, and logs per-story progress", async () => {
    const logs: string[] = [];
    // "b" fails at the provider so we exercise both the ok and pending log lines.
    const provider = fakeImageProvider({
      impl: (p) => (p === "TEST-STYLE Scene: b" ? null : bytes(`img:${p}`)),
    });
    const storage = fakeStorageProvider();
    const result = await generateImages(
      config,
      manifestOf(eligible("a"), eligible("b"), eligible("c")),
      { provider, storage, now: fixedNow(NOW), log: (m) => logs.push(m) },
      { concurrency: 3 },
    );

    // Output order follows the manifest, independent of task finish order.
    expect(result.stored).toEqual(["a", "c"]);
    expect(result.failed).toBe(1);
    expect(logs).toHaveLength(3);
    expect(logs.filter((l) => / ok \(/.test(l))).toHaveLength(2);
    expect(logs.some((l) => /^image 2\/3 b: pending \(/.test(l))).toBe(true);
  });
});

describe("detectImageContentType", () => {
  it("detects JPEG from FF D8 FF", () => {
    expect(detectImageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("detects PNG from the 8-byte signature", () => {
    expect(
      detectImageContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
  });

  it("detects WebP from RIFF....WEBP", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageContentType(webp)).toBe("image/webp");
  });

  it("defaults to PNG for unknown or too-short input", () => {
    expect(detectImageContentType(new Uint8Array([0x00, 0x01, 0x02]))).toBe("image/png");
    expect(detectImageContentType(new Uint8Array(0))).toBe("image/png");
  });
});
