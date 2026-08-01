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
  fakeTextGenerator,
  fixedNow,
  lettersPersona,
  makeConfig,
  makeFetch,
  newsPersona,
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

/** A fully generated + stored record (all publish fields + imageUrl). */
function fullRecord(id: string): ManifestRecord {
  return {
    ...pending(id),
    headline: `Headline ${id}`,
    description: "A description.",
    imagePrompt: "a scene",
    wrappedPrompt: `TEST-STYLE Scene: ${id}`,
    category: "WORLD",
    caption: `A neutral scene for ${id}.`,
    imageUrl: `https://cdn.test/${id}.png`,
    imageStoredAt: NOW,
  };
}

/** Build CycleDeps with recording fakes + an in-memory IO seeded from `manifest`. */
function makeDeps(
  manifest: Manifest,
  over: Partial<CycleDeps> = {},
  ioOpts: Parameters<typeof fakeCycleIo>[1] = {},
) {
  const logs: string[] = [];
  const generator = fakeGenerator({});
  const textGenerator = fakeTextGenerator();
  const commentGenerator = fakeTextGenerator();
  const imageProvider = fakeImageProvider({});
  const storage = fakeStorageProvider();
  const deployRun = fakeDeployRunner({ code: 0 });
  const io = fakeCycleIo(manifest, ioOpts);
  const deps: CycleDeps = {
    now: fixedNow(NOW),
    fetch: makeFetch({}),
    generator,
    textGenerator,
    commentGenerator,
    imageProvider,
    storage,
    deployRun,
    io,
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, logs, generator, textGenerator, commentGenerator, imageProvider, storage, deployRun, io };
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
      "headshots",
      "ingest",
      "generate",
      "opinions",
      "image",
      "ageout",
      "comments",
      "render",
      "deploy",
    ]);
    // The headshots boundary ran with the by-convention paths + the cycle's storage.
    expect(io.headshotCalls).toEqual([
      { dir: "assets/headshots", manifestPath: "data/headshots.json" },
    ]);
    expect(result.stages.headshots).toBe("0 processed, 0 skipped, 0 missing, 0 failed");
    // Providers were actually driven.
    expect(generator.calls).toHaveLength(1);
    expect(imageProvider.calls).toHaveLength(1);
    expect(storage.puts).toHaveLength(1);
    // Deploy ran last with the configured command + cwd.
    expect(deployRun.calls).toEqual([{ command: config.deploy.command, cwd: config.deploy.cwd }]);
    expect(result.deploy?.status).toBe("deployed");
    // Persistence: manifest after each of the 4 pipeline stages + opinions, published ×2,
    // site ×1.
    expect(io.writes.filter((w) => w.kind === "manifest")).toHaveLength(5);
    expect(io.writes.filter((w) => w.kind === "published")).toHaveLength(2);
    expect(io.writes.filter((w) => w.kind === "site")).toHaveLength(1);
    // The rendered site carried a real cover page.
    const site = io.writes.find((w) => w.kind === "site");
    expect(site?.files?.["index.html"]).toBeTruthy();
  });

  it("reports the image stage in the ADR-0020 four-bucket shape", async () => {
    const config = makeConfig();
    const { deps } = makeDeps(manifestOf(pending("a")));

    const result = await runCycle(config, deps, FULL);

    expect(result.stages.image).toBe(
      "1 generated, 0 skipped-below-fold, 0 skipped-near-ageout, 0 failed",
    );
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

describe("runCycle — a deploy that RAN and failed exits non-zero", () => {
  it("maps a non-zero deploy to ok:false / failedStage:deploy (not a silent OK)", async () => {
    const config = makeConfig();
    // Let the pipeline generate + image the record so it's genuinely publishable (storage.exists
    // passes) and the guard lets the deploy command actually run — which then exits non-zero.
    // NB: hold our own reference — makeDeps returns its internal (unused) runner, not the override.
    const deployRun = fakeDeployRunner({ code: 1 });
    const { deps } = makeDeps(manifestOf(pending("a")), { deployRun });

    const result = await runCycle(config, deps, FULL);

    expect(deployRun.calls).toHaveLength(1); // the command ran
    expect(result.deploy?.status).toBe("failed");
    expect(result.ok).toBe(false); // → CLI exits 1, cron sees the stale-site failure
    expect(result.failedStage).toBe("deploy");
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
    const { deps, generator, textGenerator, imageProvider, storage, deployRun, io } = makeDeps(
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
    // Still reports intended actions per stage (incl. the up-front storage preflight).
    expect(Object.keys(result.stages)).toEqual([
      "storage-preflight",
      "headshots",
      "ingest",
      "generate",
      "opinions",
      "image",
      "ageout",
      "comments",
      "render",
      "deploy",
    ]);
    expect(result.stages["storage-preflight"]).toContain("ok");
    // Headshots report a "would …" line only — the boundary itself is never invoked.
    expect(result.stages.headshots).toContain("would");
    expect(io.headshotCalls).toHaveLength(0);
    // Opinions report a derivation-only "would …" line — no text-generation calls.
    expect(result.stages.opinions).toContain("would");
    expect(textGenerator.calls).toHaveLength(0);
  });

  it("--dry-run counts stale records per category window, matching the real ageout gate", async () => {
    // 72h-old records under maxAgeHours=48 / opinionMaxAgeHours=168: the WORLD one is
    // stale, the OPINION one is not. An unbranched countStale would report 2 here.
    const config = makeConfig({ maxAgeHours: 48, opinionMaxAgeHours: 168 });
    const old = "2026-07-07T12:00:00.000Z"; // 72h before NOW
    const { deps } = makeDeps(
      manifestOf(
        { ...fullRecord("op"), category: "OPINION", lastSeen: old },
        { ...fullRecord("wd"), category: "WORLD", lastSeen: old },
      ),
    );

    const result = await runCycle(config, deps, { deploy: false, dryRun: true });

    expect(result.stages.ageout).toBe("1 stale would be dropped");
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

describe("runCycle — headshots stage is tolerant", () => {
  it("a throwing headshots boundary keeps ok:true and the pipeline running", async () => {
    const config = makeConfig();
    const { deps, deployRun, io } = makeDeps(manifestOf(fullRecord("a")), {}, {
      throwOnHeadshots: true,
    });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.failedStage).toBeUndefined();
    expect(result.stages.headshots).toContain("skipped — simulated headshots failure");
    // The rest of the cycle proceeded all the way to deploy.
    expect(io.writes.filter((w) => w.kind === "site")).toHaveLength(1);
    expect(deployRun.calls).toHaveLength(1);
  });

  it("surfaces the boundary's summary counts as the stage line", async () => {
    const config = makeConfig();
    const { deps } = makeDeps(manifestOf(fullRecord("a")), {}, {
      headshots: {
        processed: ["alice"],
        skipped: ["bob", "cynthia"],
        missing: ["edgar"],
        failed: [],
        manifest: { version: 1, headshots: {} },
      },
    });

    const result = await runCycle(config, deps, FULL);

    expect(result.stages.headshots).toBe("1 processed, 2 skipped, 1 missing, 0 failed");
  });
});

describe("runCycle — opinions stage (ADR-0015/0016): tolerant, ordered before image", () => {
  // NOW (2026-07-10) is a Friday, rotation index 20644 % 3 = 1 → edgar+stryker, plus tom
  // (mon/wed/fri/sun letters schedule).
  const assets = {
    personas: [
      newsPersona("edgar"),
      newsPersona("stryker"),
      lettersPersona("tom", ["mon", "wed", "fri", "sun"]),
    ],
    shared: "SHARED RULES",
    letters: "LETTER RULES",
    comments: "COMMENT RULES",
  };

  it("a throwing persona-assets boundary keeps ok:true and the cycle deploys", async () => {
    const config = makeConfig();
    const { deps, deployRun, io } = makeDeps(manifestOf(fullRecord("a")), {}, {
      throwOnPersonaAssets: true,
    });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.failedStage).toBeUndefined();
    expect(result.stages.opinions).toContain("skipped — simulated persona assets failure");
    expect(io.writes.filter((w) => w.kind === "site")).toHaveLength(1);
    expect(deployRun.calls).toHaveLength(1);
  });

  it("same-cycle hero: the letter piece publishes, images, and reaches the rendered site", async () => {
    const config = makeConfig();
    // The piece impl is valid for tom's letter column but NOT valid JSON for the gate
    // call → the gate fails closed and both news authors skip (isolated tolerance);
    // the brief impl gives tom his hero prompt + caption (ADR-0016).
    const textGenerator = fakeTextGenerator({
      impl: (prompt) =>
        prompt.includes("image brief")
          ? JSON.stringify({ imagePrompt: "a park scene", caption: "A caption" })
          : `A Test Title\n\n${"word ".repeat(1600).trim()}`,
    });
    const { deps, io } = makeDeps(manifestOf(fullRecord("a")), { textGenerator }, {
      personaAssets: assets,
      // The headshots stage's manifest feeds the render's author directory (ADR-0016).
      headshots: {
        processed: [],
        skipped: ["tom"],
        missing: [],
        failed: [],
        manifest: {
          version: 1,
          headshots: {
            tom: {
              persona: "tom",
              sourceHash: "abc",
              avatarUrl: "https://cdn.test/headshots/tom.webp",
              processedAt: NOW,
            },
          },
        },
      },
    });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.stages.opinions).toBe(
      "1 published, 2 skipped, 0 failed; gate failed closed (1 candidate(s) excluded)",
    );
    // The piece carries its brief AND — because opinions now runs before the image
    // stage (ADR-0016 d.5) — its hero, all within this one cycle.
    const saved = io.saved?.stories["opinion-tom-2026-07-10"];
    expect(saved).toBeDefined();
    expect(saved?.author).toBe("tom");
    expect(saved?.columnTitle).toBe("tom's Column");
    expect(saved?.imagePrompt).toBe("a park scene");
    expect(saved?.wrappedPrompt).toContain("a park scene");
    expect(saved?.caption).toBe("A caption");
    expect(saved?.imageUrl).toBeTruthy();
    // Publishable piece → the render emitted the Opinion section + the piece page, with
    // the byline row resolved through the headshots manifest + persona assets.
    const site = io.writes.find((w) => w.kind === "site");
    expect(site?.files?.["opinion.html"]).toBeTruthy();
    expect(site?.files?.["opinion.html"]).toContain("https://cdn.test/headshots/tom.webp");
    expect(site?.files?.["opinion.html"]).toContain("Tom"); // displayName from the persona
    expect(site?.files?.["s/opinion-tom-2026-07-10.html"]).toContain("tom is a bot."); // blurb footer
    // Opinions runs after generate and before image (stage-key order is insertion order).
    const keys = Object.keys(result.stages);
    expect(keys.indexOf("opinions")).toBeGreaterThan(keys.indexOf("generate"));
    expect(keys.indexOf("opinions")).toBeLessThan(keys.indexOf("image"));
  });
});

describe("runCycle — opinion publish-hour gate + OPINION-STALE (ADR-0018)", () => {
  // NOW pins the clock at 12:00 UTC; the fixture config opens the gate (hour 0), so
  // these tests override opinionPublishHourUTC explicitly to exercise the boundary.
  const assets = {
    personas: [lettersPersona("tom", ["mon", "wed", "fri", "sun"])],
    shared: "SHARED RULES",
    letters: "LETTER RULES",
    comments: "COMMENT RULES",
  };

  /** An OPINION record whose lastSeen is `hoursOld` before NOW. */
  function opinionRecord(id: string, hoursOld: number): ManifestRecord {
    const lastSeen = new Date(new Date(NOW).getTime() - hoursOld * 3600_000).toISOString();
    return { ...fullRecord(id), category: "OPINION", author: id.split("-")[1], lastSeen };
  }

  it("hour 12 < 13: distinct skipped-hour status, ZERO provider calls, cycle continues", async () => {
    const config = makeConfig({ opinionPublishHourUTC: 13 });
    const { deps, logs, textGenerator, deployRun, io } = makeDeps(manifestOf(fullRecord("a")), {}, {
      personaAssets: assets,
    });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.stages.opinions).toBe("skipped — before publish hour (12 < 13 UTC)");
    // The whole point: the topic-gate classifier must not burn before the publish hour.
    expect(textGenerator.calls).toHaveLength(0);
    // The structured outcome still logs, with the distinct status.
    expect(logs.join("\n")).toContain('"status":"skipped-hour"');
    // The news pipeline is unaffected: the cycle rendered and deployed as usual.
    expect(io.writes.filter((w) => w.kind === "site")).toHaveLength(1);
    expect(deployRun.calls).toHaveLength(1);
  });

  it("hour 13 >= 13 (the boundary): the stage runs and logs a status:ran outcome", async () => {
    const config = makeConfig({ opinionPublishHourUTC: 13 });
    const textGenerator = fakeTextGenerator({
      impl: (prompt) =>
        prompt.includes("image brief")
          ? JSON.stringify({ imagePrompt: "a park scene", caption: "A caption" })
          : `A Test Title\n\n${"word ".repeat(1600).trim()}`,
    });
    const { deps, logs, io } = makeDeps(
      manifestOf(fullRecord("a")),
      { now: fixedNow("2026-07-10T13:00:00.000Z"), textGenerator },
      { personaAssets: assets },
    );

    const result = await runCycle(config, deps, FULL);

    expect(result.stages.opinions).toBe("1 published, 0 skipped, 0 failed; gate not run");
    expect(textGenerator.calls.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain('"status":"ran"');
    expect(logs.join("\n")).toContain('"published":["opinion-tom-2026-07-10"]');
    expect(io.saved?.stories["opinion-tom-2026-07-10"]).toBeDefined();
  });

  it("dry-run prints the gate decision and mutates nothing", async () => {
    const config = makeConfig({ opinionPublishHourUTC: 13 });
    const { deps, textGenerator, io } = makeDeps(manifestOf(fullRecord("a")), {}, {
      personaAssets: assets,
    });

    const result = await runCycle(config, deps, { deploy: true, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.stages.opinions).toBe("would skip — before publish hour (12 < 13 UTC)");
    expect(textGenerator.calls).toHaveLength(0);
    expect(io.writes).toHaveLength(0);
  });

  it("OPINION-STALE fires past 36h with the age and last-known key — every full cycle", async () => {
    const config = makeConfig();
    const { deps, logs } = makeDeps(manifestOf(opinionRecord("opinion-tom-2026-07-08", 41)));

    await runCycle(config, deps, FULL);

    const line = logs.find((l) => l.includes("OPINION-STALE"));
    expect(line).toContain("newest OPINION record is 41h old (opinion-tom-2026-07-08)");
    expect(line).toContain("threshold 36h");
  });

  it("OPINION-STALE fires on an empty store", async () => {
    const config = makeConfig();
    const { deps, logs } = makeDeps(manifestOf());

    await runCycle(config, deps, FULL);

    expect(logs.find((l) => l.includes("OPINION-STALE"))).toContain(
      "no OPINION records in the manifest",
    );
  });

  it("OPINION-STALE stays silent below the threshold", async () => {
    const config = makeConfig();
    const { deps, logs } = makeDeps(manifestOf(opinionRecord("opinion-tom-2026-07-10", 10)));

    await runCycle(config, deps, FULL);

    expect(logs.join("\n")).not.toContain("OPINION-STALE");
  });

  it("OPINION-STALE runs on a skipped-hour cycle AND on a dry-run", async () => {
    const config = makeConfig({ opinionPublishHourUTC: 13 });
    const stale = () => manifestOf(opinionRecord("opinion-tom-2026-07-08", 41));

    const gated = makeDeps(stale(), {}, { personaAssets: assets });
    const gatedResult = await runCycle(config, gated.deps, FULL);
    expect(gatedResult.stages.opinions).toContain("before publish hour");
    expect(gated.logs.join("\n")).toContain("OPINION-STALE");

    const dry = makeDeps(stale(), {}, { personaAssets: assets });
    await runCycle(config, dry.deps, { deploy: true, dryRun: true });
    expect(dry.logs.join("\n")).toContain("OPINION-STALE");
  });
});

describe("runCycle — storage preflight (fail-loud) + existence-verified render", () => {
  it("aborts up front when the preflight fails — no generation, no writes, no deploy, non-zero", async () => {
    const config = makeConfig();
    const storage = fakeStorageProvider({
      preflight: () => ({
        ok: false,
        message: "storage preflight FAILED: needs BLOB_READ_WRITE_TOKEN",
      }),
    });
    const { deps, generator, imageProvider, deployRun, io } = makeDeps(manifestOf(pending("a")), {
      storage,
    });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("storage-preflight");
    expect(result.stages["storage-preflight"]).toContain("FAILED");
    // Aborted BEFORE any work: nothing generated, stored, written, or deployed.
    expect(generator.calls).toHaveLength(0);
    expect(imageProvider.calls).toHaveLength(0);
    expect(storage.puts).toHaveLength(0);
    expect(io.writes).toHaveLength(0);
    expect(deployRun.calls).toHaveLength(0);
  });

  it("render excludes a record whose image does not resolve, even with a fresh imageUrl", async () => {
    const config = makeConfig();
    // Storage says only "keep" resolves. "drop" is recleared + re-imaged (put succeeds) but is
    // STILL excluded from the page by the render existence gate — never a dangling <img>.
    const keep = { ...fullRecord("keep"), firstSeen: "2026-07-10T10:00:00.000Z" };
    const drop = { ...fullRecord("drop"), firstSeen: "2026-07-10T09:00:00.000Z" };
    const storage = fakeStorageProvider({ exists: (id) => id === "keep" });
    const { deps } = makeDeps(manifestOf(keep, drop), { storage });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.stages.render).toContain("1 publishable");
    expect(result.deploy?.status).toBe("deployed");
  });
});

describe("runCycle — reader comments stage (ADR-0028)", () => {
  /** A publishable OPINION record already imaged (skips generate/image, survives ageout). */
  function opinionRecord(): ManifestRecord {
    return {
      ...fullRecord("opinion-alice-2026-07-10"),
      url: "",
      category: "OPINION",
      author: "alice",
    };
  }

  const withComments = (over: Partial<Config["comments"]> = {}): Partial<Config> => ({
    comments: {
      enabled: true,
      initialCount: 3,
      perPassCount: 2,
      maxPerPiece: 60,
      growWindowHours: 72,
      model: "test-comments-model",
      ...over,
    },
  });

  it("seeds comments on a published opinion piece and bakes them into its page", async () => {
    const config = makeConfig(withComments());
    const commentGenerator = fakeTextGenerator({
      impl: () =>
        JSON.stringify({
          comments: [
            { username: "georgiapirate66", body: "The framers are ROLLING in there graves", replyTo: null },
            { username: "rickp53", body: "Article 9 clearly states this", replyTo: null },
            { username: "Whatstheuseanyway", body: "Both.", replyTo: "new:0" },
          ],
        }),
    });
    const { deps, io } = makeDeps(manifestOf(opinionRecord()), { commentGenerator });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.stages.comments).toContain("seeded");
    expect(commentGenerator.calls).toHaveLength(1);
    // The comment thread was baked into the piece's landing page.
    const site = io.writes.find((w) => w.kind === "site");
    const page = site?.files?.["s/opinion-alice-2026-07-10.html"];
    expect(page).toContain("georgiapirate66");
    expect(page).toContain("Reader comments are parody");
    // The comments persisted onto the manifest record.
    const stored = io.saved?.stories["opinion-alice-2026-07-10"].comments;
    expect(stored).toHaveLength(3);
  });

  it("is tolerant: a null comment completion leaves the cycle ok and still deploys", async () => {
    const config = makeConfig(withComments());
    const commentGenerator = fakeTextGenerator({ impl: () => null });
    const { deps, io } = makeDeps(manifestOf(opinionRecord()), { commentGenerator });

    const result = await runCycle(config, deps, FULL);

    expect(result.ok).toBe(true);
    expect(result.stages.comments).toContain("failed");
    expect(result.deploy?.status).toBe("deployed");
    expect(io.saved?.stories["opinion-alice-2026-07-10"].comments).toBeUndefined();
  });

  it("enabled:false skips the stage with zero generator calls", async () => {
    const config = makeConfig(withComments({ enabled: false }));
    const commentGenerator = fakeTextGenerator();
    const { deps } = makeDeps(manifestOf(opinionRecord()), { commentGenerator });

    const result = await runCycle(config, deps, FULL);

    expect(result.stages.comments).toContain("skipped");
    expect(commentGenerator.calls).toHaveLength(0);
  });
});
