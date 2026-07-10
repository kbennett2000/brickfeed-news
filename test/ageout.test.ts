import { describe, expect, it } from "vitest";
import { ageOut } from "../src/ageout.js";
import type { AgeOutDeps } from "../src/ageout.js";
import type { Manifest, ManifestRecord } from "../src/types.js";
import { fakeStorageProvider, fixedNow, makeConfig } from "./helpers.js";

const NOW = "2025-07-10T00:00:00.000Z";
const config = makeConfig({ maxAgeHours: 72 }); // 3 days

/** A record last seen at a given ISO time, optionally with a stored image. */
function record(id: string, lastSeen: string, withImage = true): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Story ${id}`,
    sourceName: "Src",
    firstSeen: "2025-06-01T00:00:00.000Z",
    lastSeen,
    headline: `Headline ${id}`,
    description: "A description.",
    imagePrompt: "a scene",
    wrappedPrompt: "STYLE scene",
    ...(withImage ? { imageUrl: `https://cdn.test/${id}.png`, imageStoredAt: lastSeen } : {}),
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

function depsWith(storage: AgeOutDeps["storage"]): AgeOutDeps {
  return { storage, now: fixedNow(NOW) };
}

describe("ageOut", () => {
  it("drops a stale record AND deletes its stored image", async () => {
    const storage = fakeStorageProvider();
    // 4 days old > 72h → stale.
    const manifest = manifestOf(record("stale", "2025-07-06T00:00:00.000Z"));

    const result = await ageOut(config, manifest, depsWith(storage));

    expect(result.dropped).toEqual(["stale"]);
    expect(result.manifest.stories.stale).toBeUndefined();
    expect(storage.deletes).toEqual(["stale"]);
  });

  it("keeps a fresh record untouched and never calls delete for it", async () => {
    const storage = fakeStorageProvider();
    // 1 day old < 72h → fresh.
    const manifest = manifestOf(record("fresh", "2025-07-09T00:00:00.000Z"));

    const result = await ageOut(config, manifest, depsWith(storage));

    expect(result.dropped).toEqual([]);
    expect(result.manifest.stories.fresh).toBeDefined();
    expect(storage.deletes).toEqual([]);
  });

  it("drops a stale record with no imageUrl WITHOUT calling delete", async () => {
    const storage = fakeStorageProvider();
    const manifest = manifestOf(record("stale", "2025-07-01T00:00:00.000Z", false));

    const result = await ageOut(config, manifest, depsWith(storage));

    expect(result.dropped).toEqual(["stale"]);
    expect(result.deleteAttempted).toEqual([]);
    expect(storage.deletes).toEqual([]);
  });

  it("delete failure is non-fatal: the record is still dropped", async () => {
    const storage = fakeStorageProvider({ throwOnDelete: new Set(["stale"]) });
    const manifest = manifestOf(record("stale", "2025-07-01T00:00:00.000Z"));

    // ageOut awaits delete; a throwing delete must not reject the pass.
    const result = await ageOut(config, manifest, depsWith(storage));

    expect(result.dropped).toEqual(["stale"]);
    expect(result.manifest.stories.stale).toBeUndefined();
  });

  it("does not mutate the starting manifest", async () => {
    const storage = fakeStorageProvider();
    const manifest = manifestOf(record("stale", "2025-07-01T00:00:00.000Z"));

    await ageOut(config, manifest, depsWith(storage));

    expect(manifest.stories.stale).toBeDefined();
  });

  it("keeps a record with an unparseable lastSeen (treated as not stale)", async () => {
    const storage = fakeStorageProvider();
    const manifest = manifestOf(record("weird", "not-a-date"));

    const result = await ageOut(config, manifest, depsWith(storage));

    expect(result.dropped).toEqual([]);
    expect(result.manifest.stories.weird).toBeDefined();
  });
});
