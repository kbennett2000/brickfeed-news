import { describe, expect, it } from "vitest";
import { runCycle } from "../src/cycle.js";
import type { Config } from "../src/config.js";
import type { CycleDeps, Manifest, ManifestRecord } from "../src/types.js";
import {
  fakeCycleIo,
  fakeDeployRunner,
  fakeGenerator,
  fakeImageProvider,
  fakeStorageProvider,
  fixedNow,
  makeConfig,
  makeFetch,
} from "./helpers.js";

const NOW = "2026-07-10T12:00:00.000Z";

/** A fresh pending record (id/url/title only) — flows through generate → image → publish. */
function pending(id: string): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Story ${id}`,
    sourceName: "Test Wire",
    firstSeen: NOW,
    lastSeen: NOW,
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

/** Build CycleDeps with recording fakes + an in-memory IO seeded from `manifest`. */
function makeDeps(
  manifest: Manifest,
  over: Partial<CycleDeps> = {},
  ioOpts: Parameters<typeof fakeCycleIo>[1] = {},
) {
  const logs: string[] = [];
  const generator = fakeGenerator({});
  const imageProvider = fakeImageProvider({});
  const storage = fakeStorageProvider();
  const deployRun = fakeDeployRunner({ code: 0 });
  const io = fakeCycleIo(manifest, ioOpts);
  const deps: CycleDeps = {
    now: fixedNow(NOW),
    fetch: makeFetch({}),
    generator,
    imageProvider,
    storage,
    deployRun,
    io,
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, logs, generator, imageProvider, storage, deployRun, io };
}

const FULL = { deploy: true, dryRun: false };

describe("runCycle — full chain (happy path)", () => {
  it("invokes the stages in the exact contract order, then deploys", async () => {
    const config = makeConfig();
    const { deps, generator, imageProvider, storage, deployRun, io } = makeDeps(
      manifestOf(pending("a")),
    );

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    // Exact stage order (object keys preserve insertion order).
    expect(Object.keys(result.stages)).toEqual([
      "ingest",
      "generate",
      "image",
      "ageout",
      "render",
      "deploy",
    ]);
    // Providers were actually driven.
    expect(generator.calls).toHaveLength(1);
    expect(imageProvider.calls).toHaveLength(1);
    expect(storage.puts).toHaveLength(1);
    // Deploy ran last with the configured command + cwd.
    expect(deployRun.calls).toEqual([{ command: config.deploy.command, cwd: config.deploy.cwd }]);
    expect(result.deploy?.status).toBe("deployed");
    // Persistence: manifest after each of the 4 mutating stages, published ×2, site ×1.
    expect(io.writes.filter((w) => w.kind === "manifest")).toHaveLength(4);
    expect(io.writes.filter((w) => w.kind === "published")).toHaveLength(2);
    expect(io.writes.filter((w) => w.kind === "site")).toHaveLength(1);
    // The rendered site carried a real cover page.
    const site = io.writes.find((w) => w.kind === "site");
    expect(site?.files?.["index.html"]).toBeTruthy();
  });
});

describe("runCycle — hard stage failure aborts before deploy", () => {
  it("a thrown render write aborts, exits non-zero, and never deploys", async () => {
    const config = makeConfig();
    const { deps, deployRun } = makeDeps(manifestOf(pending("a")), {}, { throwOn: "site" });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("render");
    expect(result.stages.render).toMatch(/^FAILED:/);
    expect(result.deploy).toBeUndefined();
    expect(deployRun.calls).toHaveLength(0);
  });

  it("a thrown manifest write aborts at the first stage before deploy", async () => {
    const config = makeConfig();
    const { deps, deployRun } = makeDeps(manifestOf(pending("a")), {}, { throwOn: "manifest" });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("ingest");
    expect(deployRun.calls).toHaveLength(0);
  });
});

describe("runCycle — empty/invalid render guard blocks deploy (non-fatal)", () => {
  it("refuses deploy when there are zero publishable records, but stays ok (exit 0)", async () => {
    const config = makeConfig();
    // Empty manifest → nothing generated → nothing publishable.
    const { deps, deployRun } = makeDeps(manifestOf());

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true); // non-fatal: exit 0
    expect(result.deploy?.status).toBe("refused-empty");
    expect(deployRun.calls).toHaveLength(0);
  });
});

describe("runCycle — flags", () => {
  it("--no-deploy runs every stage but skips deploy", async () => {
    const config = makeConfig();
    const { deps, generator, imageProvider, deployRun, io } = makeDeps(manifestOf(pending("a")));

    const result = await runCycle(config, deps, { deploy: false, dryRun: false });

    expect(result.ok).toBe(true);
    expect(generator.calls).toHaveLength(1); // stages still ran
    expect(imageProvider.calls).toHaveLength(1);
    expect(io.writes.length).toBeGreaterThan(0); // still persisted
    expect(result.deploy?.status).toBe("skipped-flag");
    expect(deployRun.calls).toHaveLength(0);
  });

  it("--dry-run mutates nothing: no providers, no writes, no deploy", async () => {
    const config = makeConfig();
    const { deps, generator, imageProvider, storage, deployRun, io } = makeDeps(
      manifestOf(pending("a")),
    );

    const result = await runCycle(config, deps, { deploy: true, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(generator.calls).toHaveLength(0);
    expect(imageProvider.calls).toHaveLength(0);
    expect(storage.puts).toHaveLength(0);
    expect(io.writes).toHaveLength(0);
    expect(deployRun.calls).toHaveLength(0);
    expect(result.deploy).toBeUndefined();
    // Still reports intended actions per stage.
    expect(Object.keys(result.stages)).toEqual([
      "ingest",
      "generate",
      "image",
      "ageout",
      "render",
      "deploy",
    ]);
  });

  it("deploy.enabled=false skips deploy (same as --no-deploy) even when requested", async () => {
    const config: Config = makeConfig({
      deploy: { command: "vercel --prod --yes", cwd: "site", enabled: false },
    });
    const { deps, deployRun } = makeDeps(manifestOf(pending("a")));

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.deploy?.status).toBe("skipped-disabled");
    expect(deployRun.calls).toHaveLength(0);
  });
});
