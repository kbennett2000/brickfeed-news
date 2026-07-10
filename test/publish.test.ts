import { describe, expect, it } from "vitest";
import { isPublishable, publishableRecords } from "../src/publish.js";
import type { Manifest, ManifestRecord } from "../src/types.js";

/** A fully publishable record (headline + description + imageUrl). */
function full(id: string, firstSeen: string): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Story ${id}`,
    sourceName: "Src",
    firstSeen,
    lastSeen: firstSeen,
    headline: `Headline ${id}`,
    description: "A description.",
    imagePrompt: "a scene",
    wrappedPrompt: "STYLE scene",
    imageUrl: `https://cdn.test/${id}.png`,
    imageStoredAt: firstSeen,
  };
}

describe("isPublishable — truth table", () => {
  const base = full("a", "2025-07-01T00:00:00.000Z");

  it("is true only with headline + description + imageUrl", () => {
    expect(isPublishable(base)).toBe(true);
  });

  it("is false without a headline", () => {
    expect(isPublishable({ ...base, headline: undefined })).toBe(false);
  });

  it("is false without a description", () => {
    expect(isPublishable({ ...base, description: undefined })).toBe(false);
  });

  it("is false without an imageUrl (image-gated)", () => {
    expect(isPublishable({ ...base, imageUrl: undefined })).toBe(false);
  });

  it("treats empty strings as absent", () => {
    expect(isPublishable({ ...base, headline: "" })).toBe(false);
    expect(isPublishable({ ...base, imageUrl: "" })).toBe(false);
  });
});

describe("publishableRecords", () => {
  it("returns only publishable records, newest-first by firstSeen", () => {
    const manifest: Manifest = {
      version: 1,
      stories: {
        old: full("old", "2025-07-01T00:00:00.000Z"),
        newest: full("newest", "2025-07-05T00:00:00.000Z"),
        mid: full("mid", "2025-07-03T00:00:00.000Z"),
        // Not publishable: no imageUrl → excluded regardless of firstSeen.
        pending: { ...full("pending", "2025-07-09T00:00:00.000Z"), imageUrl: undefined },
      },
    };

    const ids = publishableRecords(manifest).map((r) => r.id);
    expect(ids).toEqual(["newest", "mid", "old"]);
  });

  it("returns an empty array when nothing is publishable", () => {
    const manifest: Manifest = {
      version: 1,
      stories: { p: { ...full("p", "2025-07-01T00:00:00.000Z"), imageUrl: undefined } },
    };
    expect(publishableRecords(manifest)).toEqual([]);
  });
});
