import { describe, expect, it } from "vitest";
import { generateImages } from "../src/image.js";
import type { ImageDeps, Manifest, ManifestRecord } from "../src/types.js";
import { bytes, fakeImageProvider, fixedNow, makeConfig } from "./helpers.js";

const NOW = "2025-07-08T00:00:00.000Z";
const config = makeConfig();

/** A record that has been through generation (has a wrappedPrompt → renderable). */
function renderable(id: string): ManifestRecord {
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

/** A pending record with no wrappedPrompt yet (not renderable). */
function pending(id: string): ManifestRecord {
  const r = renderable(id);
  delete r.headline;
  delete r.description;
  delete r.imagePrompt;
  delete r.wrappedPrompt;
  return r;
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

/** A capturing writeImage sink + the deps bundle around a given provider. */
function depsWith(provider: ImageDeps["provider"]): {
  deps: ImageDeps;
  writes: Map<string, Uint8Array>;
} {
  const writes = new Map<string, Uint8Array>();
  const deps: ImageDeps = {
    provider,
    writeImage: async (id, b) => {
      writes.set(id, b);
    },
    now: fixedNow(NOW),
  };
  return { deps, writes };
}

describe("generateImages", () => {
  it("renders each record with a wrappedPrompt and writes its bytes by id", async () => {
    const provider = fakeImageProvider({});
    const { deps, writes } = depsWith(provider);
    const manifest = manifestOf(renderable("a"), renderable("b"));

    const result = await generateImages(config, manifest, deps);

    expect(result.written.sort()).toEqual(["a", "b"]);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(provider.calls.sort()).toEqual(["TEST-STYLE Scene: a", "TEST-STYLE Scene: b"]);
    expect(writes.get("a")).toEqual(bytes("img:TEST-STYLE Scene: a"));
    expect(writes.get("b")).toEqual(bytes("img:TEST-STYLE Scene: b"));
  });

  it("skips records without a wrappedPrompt and never calls the provider for them", async () => {
    const provider = fakeImageProvider({});
    const { deps, writes } = depsWith(provider);
    const manifest = manifestOf(pending("a"), renderable("b"));

    const result = await generateImages(config, manifest, deps);

    expect(result.skipped).toBe(1);
    expect(result.written).toEqual(["b"]);
    expect(provider.calls).toEqual(["TEST-STYLE Scene: b"]);
    expect(writes.has("a")).toBe(false);
  });

  it("is resilient: a null from the provider fails one record, others still written", async () => {
    const provider = fakeImageProvider({
      impl: (p) => (p === "TEST-STYLE Scene: a" ? null : bytes(`img:${p}`)),
    });
    const { deps, writes } = depsWith(provider);
    const manifest = manifestOf(renderable("a"), renderable("b"));

    const result = await generateImages(config, manifest, deps);

    expect(result.failed).toBe(1);
    expect(result.written).toEqual(["b"]);
    expect(writes.has("a")).toBe(false);
  });

  it("is resilient: a provider that throws fails one record, the run continues", async () => {
    const provider = fakeImageProvider({ throwOn: new Set(["TEST-STYLE Scene: a"]) });
    const { deps, writes } = depsWith(provider);
    const manifest = manifestOf(renderable("a"), renderable("b"));

    const result = await generateImages(config, manifest, deps);

    expect(result.failed).toBe(1);
    expect(result.written).toEqual(["b"]);
    expect(writes.has("b")).toBe(true);
  });

  it("counts a failed write as failed and keeps going", async () => {
    const provider = fakeImageProvider({});
    const writes = new Map<string, Uint8Array>();
    const deps: ImageDeps = {
      provider,
      writeImage: async (id, b) => {
        if (id === "a") throw new Error("disk full");
        writes.set(id, b);
      },
      now: fixedNow(NOW),
    };
    const manifest = manifestOf(renderable("a"), renderable("b"));

    const result = await generateImages(config, manifest, deps);

    expect(result.failed).toBe(1);
    expect(result.written).toEqual(["b"]);
    expect(writes.has("a")).toBe(false);
  });

  it("caps attempts with opts.limit (renderable records beyond the cap untouched)", async () => {
    const provider = fakeImageProvider({});
    const { deps } = depsWith(provider);
    const manifest = manifestOf(renderable("a"), renderable("b"), renderable("c"));

    const result = await generateImages(config, manifest, deps, { limit: 2 });

    expect(provider.calls).toHaveLength(2);
    expect(result.written).toHaveLength(2);
  });

  it("limit counts attempts, not skips (pending records don't consume the budget)", async () => {
    const provider = fakeImageProvider({});
    const { deps } = depsWith(provider);
    // Two pending (skipped, free) then two renderable; limit 1 should still render one.
    const manifest = manifestOf(pending("p1"), pending("p2"), renderable("a"), renderable("b"));

    const result = await generateImages(config, manifest, deps, { limit: 1 });

    expect(result.skipped).toBe(2);
    expect(provider.calls).toHaveLength(1);
    expect(result.written).toHaveLength(1);
  });
});
