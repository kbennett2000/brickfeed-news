import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyManifest, readManifest, writeManifest } from "../src/manifest.js";
import type { Manifest } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "brickfeed-manifest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("manifest read/write", () => {
  it("returns an empty manifest when the file is missing", async () => {
    const m = await readManifest(join(dir, "does-not-exist.json"));
    expect(m).toEqual(emptyManifest());
  });

  it("round-trips a manifest through write then read", async () => {
    const path = join(dir, "nested", "manifest.json"); // nested dir must be created
    const manifest: Manifest = {
      version: 1,
      stories: {
        abc123: {
          id: "abc123",
          url: "https://example.com/story",
          title: "A story",
          sourceName: "Example",
          firstSeen: "2025-07-07T12:00:00.000Z",
          lastSeen: "2025-07-07T12:00:00.000Z",
        },
      },
    };

    await writeManifest(path, manifest);
    expect(await readManifest(path)).toEqual(manifest);
  });

  it("degrades to empty on a corrupt manifest file", async () => {
    const path = join(dir, "corrupt.json");
    await writeManifest(path, emptyManifest());
    // Overwrite with garbage.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ not json", "utf8");
    expect(await readManifest(path)).toEqual(emptyManifest());
  });
});
