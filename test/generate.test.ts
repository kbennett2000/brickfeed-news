import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateAll, isGenerated } from "../src/generate.js";
import { readManifest, writeManifest } from "../src/manifest.js";
import type { GenerateDeps, Manifest, ManifestRecord } from "../src/types.js";
import { fakeGenerator, fixedNow, makeConfig } from "./helpers.js";

const NOW = "2025-07-08T00:00:00.000Z";
const config = makeConfig({ brickStyle: { styleLanguage: "TEST-STYLE" } });

function pending(id: string, title: string): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
    title,
    sourceName: "Src",
    firstSeen: "2025-07-01T00:00:00.000Z",
    lastSeen: "2025-07-07T00:00:00.000Z",
  };
}

function done(id: string, title: string): ManifestRecord {
  return {
    ...pending(id, title),
    headline: "already",
    description: "already generated",
    imagePrompt: "a scene",
    wrappedPrompt: "TEST-STYLE Scene: a scene",
    category: "WORLD",
    caption: "an already-generated scene",
  };
}

/**
 * A record generated BEFORE Slice 6: it has the original four gen fields but lacks
 * category + caption. It must be treated as still-pending so it backfills on re-run.
 */
function preSliceDone(id: string, title: string): ManifestRecord {
  return {
    ...pending(id, title),
    headline: "already",
    description: "already generated",
    imagePrompt: "a scene",
    wrappedPrompt: "TEST-STYLE Scene: a scene",
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

function deps(gen = fakeGenerator({})): GenerateDeps {
  return { generator: gen, now: fixedNow(NOW) };
}

describe("generateAll", () => {
  it("generates pending records and persists all six fields together", async () => {
    const gen = fakeGenerator({});
    const result = await generateAll(config, manifestOf(pending("a", "Story A")), deps(gen));

    expect(result.generated).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const rec = result.manifest.stories["a"];
    expect(rec.headline).toBe("Rewritten: Story A");
    expect(rec.description).toContain("Story A");
    expect(rec.imagePrompt).toContain("Story A");
    // Brick wrapping uses the config style, applied to the neutral imagePrompt.
    expect(rec.wrappedPrompt).toBe(`TEST-STYLE Scene: ${rec.imagePrompt}`);
    // Slice 6 render fields written together with the rest.
    expect(rec.category).toBe("WORLD");
    expect(rec.caption).toContain("Story A");
    expect(isGenerated(rec)).toBe(true);
  });

  it("is idempotent: an already-generated record is skipped, Generator NOT called", async () => {
    const gen = fakeGenerator({});
    const result = await generateAll(config, manifestOf(done("a", "Story A")), deps(gen));

    expect(gen.calls).toHaveLength(0); // never invoked for done records
    expect(result.generated).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("never touches an opinion piece (ADR-0015): author-bearing records are skipped", async () => {
    // An opinion record has text but no image-prompt fields, so it LOOKS pending to
    // isGenerated — the author exemption is what keeps the piece from being clobbered
    // with story-style output.
    const opinion: ManifestRecord = {
      ...pending("opinion-alice-2026-07-13", "A Piece Title"),
      headline: "A Piece Title",
      description: "The full body of the opinion piece.",
      category: "OPINION",
      author: "alice",
    };
    expect(isGenerated(opinion)).toBe(false);

    const gen = fakeGenerator({});
    const result = await generateAll(config, manifestOf(opinion), deps(gen));

    expect(gen.calls).toHaveLength(0);
    expect(result.generated).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.manifest.stories["opinion-alice-2026-07-13"]).toEqual(opinion);
  });

  it("backfills a pre-Slice-6 record missing category/caption (regenerates it)", async () => {
    // The record has the original four gen fields but no category/caption.
    const stale = preSliceDone("a", "Story A");
    expect(isGenerated(stale)).toBe(false); // treated as still-pending

    const gen = fakeGenerator({});
    const result = await generateAll(config, manifestOf(stale), deps(gen));

    // It was regenerated (not skipped) and now carries the two new fields.
    expect(gen.calls).toHaveLength(1);
    expect(result.generated).toHaveLength(1);
    expect(result.skipped).toBe(0);
    const rec = result.manifest.stories["a"];
    expect(rec.category).toBe("WORLD");
    expect(rec.caption).toContain("Story A");
    expect(isGenerated(rec)).toBe(true);
  });

  it("does NOT backfill a fully-generated (Slice 6) record — still skipped", async () => {
    const gen = fakeGenerator({});
    const result = await generateAll(config, manifestOf(done("a", "Story A")), deps(gen));
    expect(gen.calls).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("never-throw: a null result leaves that record pending and others still generate", async () => {
    // Fail only Story B (impl returns null for it).
    const gen = fakeGenerator({
      impl: (input) =>
        input.title === "Story B"
          ? null
          : {
              headline: `H:${input.title}`,
              description: `D:${input.title}`,
              imagePrompt: `P:${input.title}`,
              category: "WORLD",
              caption: `C:${input.title}`,
            },
    });

    const result = await generateAll(
      config,
      manifestOf(pending("a", "Story A"), pending("b", "Story B"), pending("c", "Story C")),
      deps(gen),
    );

    expect(result.generated.map((r) => r.id).sort()).toEqual(["a", "c"]);
    expect(result.failed).toBe(1);
    // B stays pending: no generation fields written.
    expect(isGenerated(result.manifest.stories["b"])).toBe(false);
    expect(result.manifest.stories["b"].headline).toBeUndefined();
  });

  it("never-throw: a Generator that THROWS leaves the record pending, run continues", async () => {
    const gen = fakeGenerator({ throwOn: new Set(["Story A"]) });
    const result = await generateAll(
      config,
      manifestOf(pending("a", "Story A"), pending("b", "Story B")),
      deps(gen),
    );

    expect(result.failed).toBe(1);
    expect(isGenerated(result.manifest.stories["a"])).toBe(false);
    expect(isGenerated(result.manifest.stories["b"])).toBe(true);
  });

  it("re-running over a now-generated manifest regenerates nothing", async () => {
    const gen = fakeGenerator({});
    const first = await generateAll(config, manifestOf(pending("a", "Story A")), deps(gen));

    const gen2 = fakeGenerator({});
    const second = await generateAll(config, first.manifest, deps(gen2));
    expect(gen2.calls).toHaveLength(0);
    expect(second.generated).toHaveLength(0);
    expect(second.skipped).toBe(1);
  });

  it("honors opts.limit: caps how many PENDING records are attempted", async () => {
    const gen = fakeGenerator({});
    const result = await generateAll(
      config,
      manifestOf(pending("a", "A"), pending("b", "B"), pending("c", "C")),
      deps(gen),
      { limit: 2 },
    );

    expect(gen.calls).toHaveLength(2);
    expect(result.generated).toHaveLength(2);
    // The third remains pending and untouched.
    const untouched = Object.values(result.manifest.stories).filter(
      (r) => !isGenerated(r),
    );
    expect(untouched).toHaveLength(1);
  });

  it("limit counts attempts, not skips: already-done records don't consume the budget", async () => {
    const gen = fakeGenerator({});
    const result = await generateAll(
      config,
      manifestOf(done("x", "Done X"), pending("a", "A"), pending("b", "B")),
      deps(gen),
      { limit: 2 },
    );
    // Both pending records attempted; the done one was skipped, not counted.
    expect(gen.calls).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.generated).toHaveLength(2);
  });

  it("runs with concurrency, preserves manifest order, and logs per-story progress", async () => {
    const logs: string[] = [];
    // Story B fails (null) so we exercise both the ok and pending log lines.
    const gen = fakeGenerator({
      impl: (input) =>
        input.title === "B"
          ? null
          : {
              headline: `H:${input.title}`,
              description: `D:${input.title}`,
              imagePrompt: `P:${input.title}`,
              category: "WORLD",
              caption: `C:${input.title}`,
            },
    });
    const result = await generateAll(
      config,
      manifestOf(pending("a", "A"), pending("b", "B"), pending("c", "C")),
      { generator: gen, now: fixedNow(NOW), log: (m) => logs.push(m) },
      { concurrency: 3 },
    );

    // Output order follows the manifest, independent of task finish order.
    expect(result.generated.map((r) => r.id)).toEqual(["a", "c"]);
    expect(result.failed).toBe(1);
    // One log line per attempted story, with the ok/pending outcome.
    expect(logs).toHaveLength(3);
    expect(logs.filter((l) => / ok \(/.test(l))).toHaveLength(2);
    expect(logs.some((l) => /^generate 2\/3 b: pending \(/.test(l))).toBe(true);
  });
});

describe("manifest round-trips the generation fields", () => {
  const path = join(tmpdir(), `brickfeed-gen-${NOW.replace(/[:.]/g, "-")}.json`);
  afterEach(async () => {
    await rm(path, { force: true });
  });

  it("writeManifest then readManifest preserves all six generation fields", async () => {
    const gen = fakeGenerator({});
    const { manifest } = await generateAll(
      config,
      manifestOf(pending("a", "Story A")),
      deps(gen),
    );
    await writeManifest(path, manifest);
    const reloaded = await readManifest(path);

    expect(reloaded.stories["a"]).toEqual(manifest.stories["a"]);
    expect(isGenerated(reloaded.stories["a"])).toBe(true);
  });
});
