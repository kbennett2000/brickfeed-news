import { describe, expect, it } from "vitest";
import { SECTION_SLOT_LIMIT } from "../src/eligibility.js";
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

  it("picks up an opinion record purely via wrappedPrompt — zero special-casing (ADR-0016)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    // An opinion piece (ADR-0015 shape): dashed non-hex id, author set, wrappedPrompt present.
    const piece: ManifestRecord = {
      ...eligible("opinion-alice-2026-07-13"),
      url: "",
      sourceName: "",
      category: "OPINION",
      author: "alice",
      caption: "A wry caption",
    };

    const result = await generateImages(config, manifestOf(piece), depsWith(provider, storage));

    expect(result.stored).toEqual(["opinion-alice-2026-07-13"]);
    expect(provider.calls).toEqual(["TEST-STYLE Scene: opinion-alice-2026-07-13"]);
    // The dashed id flows into the storage key verbatim.
    expect(storage.puts.map((p) => p.id)).toEqual(["opinion-alice-2026-07-13"]);
    expect(result.manifest.stories["opinion-alice-2026-07-13"].imageUrl).toBe(
      "https://cdn.test/opinion-alice-2026-07-13.png",
    );
  });

  it("does not mutate the starting manifest", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const manifest = manifestOf(eligible("a"));

    await generateImages(config, manifest, depsWith(provider, storage));

    expect(manifest.stories.a.imageUrl).toBeUndefined();
  });

  it("images an older OPINION ahead of newer news within the budget (ADR-0023)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    // An OPINION older than two fresh news records. Newest-first alone would spend a limit-2
    // budget on the two news items and defer the opinion; opinion-first must rescue it.
    const opinion: ManifestRecord = {
      ...eligible("opinion-alice-2026-07-13"),
      firstSeen: "2025-07-02T00:00:00.000Z",
      category: "OPINION",
      author: "alice",
      caption: "A wry caption",
    };
    const news1 = { ...eligible("n1"), firstSeen: "2025-07-06T00:00:00.000Z" };
    const news2 = { ...eligible("n2"), firstSeen: "2025-07-07T00:00:00.000Z" };
    const manifest = manifestOf(opinion, news1, news2);

    const result = await generateImages(config, manifest, depsWith(provider, storage), {
      limit: 2,
    });

    expect(result.stored).toContain("opinion-alice-2026-07-13"); // never starved
    expect(result.stored).toHaveLength(2); // opinion + the single newest news
    expect(result.stored).toContain("n2");
    expect(result.stored).not.toContain("n1"); // oldest news deferred, not the opinion
  });

  it("retries a failed OPINION image once inline; a non-opinion miss is not retried (ADR-0023)", async () => {
    const opinionPrompt = "TEST-STYLE Scene: opinion-alice-2026-07-13";
    const newsPrompt = "TEST-STYLE Scene: n1";
    const seen: Record<string, number> = {};
    const provider = fakeImageProvider({
      impl: (wrappedPrompt) => {
        seen[wrappedPrompt] = (seen[wrappedPrompt] ?? 0) + 1;
        // Opinion fails once then succeeds; news always fails.
        if (wrappedPrompt === opinionPrompt) return seen[wrappedPrompt] === 1 ? null : bytes("ok");
        return null;
      },
    });
    const storage = fakeStorageProvider();
    const opinion: ManifestRecord = {
      ...eligible("opinion-alice-2026-07-13"),
      category: "OPINION",
      author: "alice",
      caption: "A wry caption",
    };
    const manifest = manifestOf(opinion, eligible("n1"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.stored).toEqual(["opinion-alice-2026-07-13"]); // recovered on the inline retry
    expect(seen[opinionPrompt]).toBe(2); // one retry
    expect(seen[newsPrompt]).toBe(1); // news miss NOT retried
    expect(result.failed).toBe(1); // n1 still pending
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

  it("reclears a stale imageUrl (not in storage) and re-images it; a resolving one is left alone", async () => {
    const provider = fakeImageProvider({});
    // "a" no longer resolves in the store (stale after a provider switch); "b" still does.
    const storage = fakeStorageProvider({ exists: (id) => id === "b" });
    const manifest = manifestOf(stored("a"), stored("b"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    // "a" was recleared → re-imaged into the current store; "b" was skipped (still present).
    expect(result.stored).toEqual(["a"]);
    expect(result.skipped).toBe(1);
    expect(provider.calls).toEqual(["TEST-STYLE Scene: a"]);
    expect(storage.puts.map((p) => p.id)).toEqual(["a"]);
    expect(result.manifest.stories.a.imageUrl).toBe("https://cdn.test/a.png");
    expect(result.manifest.stories.b.imageUrl).toBe("https://cdn.test/b.png"); // untouched
  });

  it("a stale record recleared but not re-imaged this run ends with NO imageUrl (never dangling)", async () => {
    // Provider fails to regenerate → the record must not keep its dangling URL.
    const provider = fakeImageProvider({ impl: () => null });
    const storage = fakeStorageProvider({ exists: () => false });
    const manifest = manifestOf(stored("a"));

    const result = await generateImages(config, manifest, depsWith(provider, storage));

    expect(result.stored).toEqual([]);
    expect(result.failed).toBe(1);
    expect(result.manifest.stories.a.imageUrl).toBeUndefined();
    expect(result.manifest.stories.a.imageStoredAt).toBeUndefined();
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

  it("images newest-first by firstSeen when capped, deferring older stories", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const older = { ...eligible("old"), firstSeen: "2025-07-01T00:00:00.000Z" };
    const mid = { ...eligible("mid"), firstSeen: "2025-07-05T00:00:00.000Z" };
    const newer = { ...eligible("new"), firstSeen: "2025-07-09T00:00:00.000Z" };
    // Insert oldest-first so it's the firstSeen sort — not insertion order — that decides.
    const manifest = manifestOf(older, mid, newer);

    const result = await generateImages(config, manifest, depsWith(provider, storage), { limit: 2 });

    // The two NEWEST are imaged, applied newest-first; the oldest is deferred (stays pending).
    expect(provider.calls).toEqual(["TEST-STYLE Scene: new", "TEST-STYLE Scene: mid"]);
    expect(result.stored).toEqual(["new", "mid"]);
    expect(result.manifest.stories.old.imageUrl).toBeUndefined();
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

  it("images only the top-K of a section; a below-fold record stays pending (ADR-0020)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    // One more than a full section, distinct firstSeen so the oldest is unambiguously rank K.
    const recs = Array.from({ length: SECTION_SLOT_LIMIT + 1 }, (_, i) => ({
      ...eligible(`w${i}`),
      firstSeen: new Date(Date.parse(NOW) - i * 60_000).toISOString(),
    }));

    const result = await generateImages(config, manifestOf(...recs), depsWith(provider, storage));

    // Provider calls == eligible count == the section slot limit; the oldest is left pending.
    expect(provider.calls).toHaveLength(SECTION_SLOT_LIMIT);
    expect(result.stored).toHaveLength(SECTION_SLOT_LIMIT);
    expect(result.belowFold).toBe(1);
    expect(result.nearAgeout).toBe(0);
    expect(result.manifest.stories[`w${SECTION_SLOT_LIMIT}`].imageUrl).toBeUndefined();
  });

  it("skips a near-ageout record, counts it, and images the rest (ADR-0020)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    // 72h retention − 65h since lastSeen = 7h left < 12h ⇒ near-ageout, no hero.
    const dying = { ...eligible("dying"), lastSeen: new Date(Date.parse(NOW) - 65 * 3_600_000).toISOString() };

    const result = await generateImages(config, manifestOf(dying, eligible("fresh")), depsWith(provider, storage));

    expect(result.nearAgeout).toBe(1);
    expect(result.stored).toEqual(["fresh"]);
    expect(provider.calls).toEqual(["TEST-STYLE Scene: fresh"]);
    expect(result.manifest.stories.dying.imageUrl).toBeUndefined();
  });

  it("always images an opinion piece, even below a full section's fold (ADR-0020)", async () => {
    const provider = fakeImageProvider({});
    const storage = fakeStorageProvider();
    const full = Array.from({ length: SECTION_SLOT_LIMIT }, (_, i) => ({
      ...eligible(`w${i}`),
      firstSeen: new Date(Date.parse(NOW) - i * 60_000).toISOString(),
    }));
    const op: ManifestRecord = {
      ...eligible("opinion-alice"),
      category: "OPINION",
      author: "alice",
      firstSeen: "2020-01-01T00:00:00.000Z", // ancient, but exempt from the slot test
    };

    const result = await generateImages(config, manifestOf(...full, op), depsWith(provider, storage));

    expect(result.stored).toContain("opinion-alice");
    expect(provider.calls).toContain("TEST-STYLE Scene: opinion-alice");
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
