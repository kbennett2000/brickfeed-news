import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ageOut } from "./ageout.js";
import type { Config } from "./config.js";
import { deploy, type DeployResult } from "./deploy.js";
import { generateAll, isGenerated } from "./generate.js";
import { hasImage, generateImages } from "./image.js";
import { ingest } from "./ingest.js";
import { readManifest, writeManifest } from "./manifest.js";
import { publishableRecords, writePublished } from "./publish.js";
import { renderSite } from "./render/index.js";
import type { CycleDeps, CycleIo, Manifest, ManifestRecord } from "./types.js";

/**
 * The result of one publish cycle. `ok` is false ONLY on a hard stage failure (a stage
 * threw) — the CLI maps that to a non-zero exit so cron/monitoring catches it. An empty
 * render that refuses deploy keeps `ok: true` (a benign, non-alarming state).
 */
export interface CycleResult {
  ok: boolean;
  dryRun: boolean;
  /** The stage that hard-failed (set iff `ok` is false). */
  failedStage?: string;
  /** Per-stage one-line summaries, in run order, for the CLI summary + tests. */
  stages: Record<string, string>;
  /** The deploy outcome; undefined if deploy was never reached (dry-run or hard abort). */
  deploy?: DeployResult;
}

export interface CycleOptions {
  /** Whether to attempt deploy at the end (false = `--no-deploy`). */
  deploy: boolean;
  /** Log intended actions and mutate nothing (`--dry-run`). */
  dryRun: boolean;
}

/**
 * Run one full publish cycle (Slice 8): ingest → generate → image+store → ageout → render
 * → deploy, in that exact order, calling the existing module functions directly in one
 * process. Every stage is already idempotent/never-throw at the STORY level, so a single
 * bad story just stays pending and the run continues. A STAGE hard-failure (a thrown
 * error — e.g. a disk write failing) is logged, aborts the run BEFORE deploy, and yields
 * `ok: false` (non-zero exit). Deploy is the last step and only runs when render produced
 * a real site (the deploy module's guard enforces that too).
 *
 * All side-effects are injected via `deps` (clock, fetch, the three configured providers,
 * the deploy subprocess, and the IO boundary) so the whole cycle is hermetically testable.
 */
export async function runCycle(
  config: Config,
  deps: CycleDeps,
  opts: CycleOptions,
): Promise<CycleResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now;
  const iso = () => now().toISOString();
  const stages: Record<string, string> = {};

  // Load the current manifest once; thread it in-memory across the stages (persisting after
  // each mutating stage for crash-resilience). A failure to even read is a hard failure.
  let manifest: Manifest;
  try {
    manifest = await deps.io.readManifest(config.manifestPath);
  } catch (err) {
    const msg = errMsg(err);
    stages["read-manifest"] = `FAILED: ${msg}`;
    log(`[${iso()}] cycle: could not read manifest — ${msg}; aborting.`);
    return { ok: false, dryRun: opts.dryRun, failedStage: "read-manifest", stages };
  }

  // --- Dry-run: log what each stage WOULD do from the current manifest; mutate nothing. ---
  if (opts.dryRun) {
    const recs = Object.values(manifest.stories);
    const pending = recs.filter((r) => !isGenerated(r)).length;
    const eligibleImages = recs.filter((r) => !!r.wrappedPrompt && !hasImage(r)).length;
    const stale = countStale(recs, config.maxAgeHours, now().getTime());
    const publishable = publishableRecords(manifest).length;

    stages.ingest = `would fetch ${config.feedUrls.length} feed(s)`;
    stages.generate = `${pending} pending would be attempted`;
    stages.image = `${eligibleImages} eligible would be attempted`;
    stages.ageout = `${stale} stale would be dropped`;
    stages.render = `${publishable} publishable would render → ${config.render.outputDir}/`;
    stages.deploy = !opts.deploy
      ? "would skip (--no-deploy)"
      : !config.deploy.enabled
        ? "would skip (deploy.enabled=false)"
        : publishable <= 0
          ? "would refuse (empty render)"
          : `would run '${config.deploy.command}' in ${config.deploy.cwd}`;

    for (const [name, summary] of Object.entries(stages)) {
      log(`[${iso()}] cycle (dry-run): ${name}: ${summary}`);
    }
    return { ok: true, dryRun: true, stages };
  }

  // --- Full run: ordered, manifest-threading stages; a throw aborts before deploy. ---
  const pipeline: { name: string; run: () => Promise<string> }[] = [
    {
      name: "ingest",
      run: async () => {
        const r = await ingest(config, manifest, { fetch: deps.fetch, now });
        manifest = r.manifest;
        await deps.io.writeManifest(config.manifestPath, manifest);
        return `${r.newStories.length} new, ${r.knownCount} known`;
      },
    },
    {
      name: "generate",
      run: async () => {
        const r = await generateAll(
          config,
          manifest,
          { generator: deps.generator, now, log },
          { limit: config.maxStoriesPerCycle, concurrency: config.concurrency },
        );
        manifest = r.manifest;
        await deps.io.writeManifest(config.manifestPath, manifest);
        return `${r.generated.length} generated, ${r.skipped} skipped, ${r.failed} pending`;
      },
    },
    {
      name: "image",
      run: async () => {
        const r = await generateImages(
          config,
          manifest,
          { provider: deps.imageProvider, storage: deps.storage, now, log },
          { limit: config.maxStoriesPerCycle, concurrency: config.concurrency },
        );
        manifest = r.manifest;
        await deps.io.writeManifest(config.manifestPath, manifest);
        await deps.io.writePublished(config.publishedPath, manifest);
        return `${r.stored.length} stored, ${r.skipped} skipped, ${r.failed} failed`;
      },
    },
    {
      name: "ageout",
      run: async () => {
        const r = await ageOut(config, manifest, { storage: deps.storage, now });
        manifest = r.manifest;
        await deps.io.writeManifest(config.manifestPath, manifest);
        await deps.io.writePublished(config.publishedPath, manifest);
        return `${r.dropped.length} dropped (${r.deleteAttempted.length} images deleted)`;
      },
    },
  ];

  for (const stage of pipeline) {
    log(`[${iso()}] cycle: ${stage.name} …`);
    try {
      stages[stage.name] = await stage.run();
    } catch (err) {
      const msg = errMsg(err);
      stages[stage.name] = `FAILED: ${msg}`;
      log(`[${iso()}] cycle: ${stage.name} hard-failed — ${msg}; aborting before deploy.`);
      return { ok: false, dryRun: false, failedStage: stage.name, stages };
    }
  }

  // Render consumes the final in-memory manifest directly (no read-back of published.json).
  let files: Record<string, string>;
  let records: ManifestRecord[];
  log(`[${iso()}] cycle: render …`);
  try {
    records = publishableRecords(manifest);
    files = renderSite(records, {
      now: now(),
      secondaryStoryCount: config.render.secondaryStoryCount,
    });
    await deps.io.writeSite(config.render.outputDir, files);
    stages.render =
      `${records.length} publishable → ${Object.keys(files).length} files ` +
      `in ${config.render.outputDir}/`;
  } catch (err) {
    const msg = errMsg(err);
    stages.render = `FAILED: ${msg}`;
    log(`[${iso()}] cycle: render hard-failed — ${msg}; aborting before deploy.`);
    return { ok: false, dryRun: false, failedStage: "render", stages };
  }

  // Deploy is last and never-throws; the guard inside refuses an empty/invalid render.
  log(`[${iso()}] cycle: deploy …`);
  const deployResult = await deploy(
    config,
    { files, publishableCount: records.length },
    { run: deps.deployRun, log },
    { requested: opts.deploy },
  );
  stages.deploy =
    deployResult.status + (deployResult.code != null ? ` (exit ${deployResult.code})` : "");

  return { ok: true, dryRun: false, stages, deploy: deployResult };
}

/** Count records whose lastSeen is older than maxAgeHours relative to nowMs. */
function countStale(records: ManifestRecord[], maxAgeHours: number, nowMs: number): number {
  const maxAgeMs = maxAgeHours * 3600_000;
  return records.filter((r) => {
    const t = new Date(r.lastSeen).getTime();
    return Number.isFinite(t) && nowMs - t > maxAgeMs;
  }).length;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The production IO boundary: delegates to the same manifest.ts / publish.ts helpers the
 * per-stage CLIs use, and writes the rendered files under the output dir (lifted from
 * render-cli.ts). Injected into runCycle by cycle-cli.ts; tests pass an in-memory fake.
 */
export const defaultCycleIo: CycleIo = {
  readManifest,
  writeManifest,
  writePublished,
  async writeSite(outputDir: string, files: Record<string, string>): Promise<void> {
    await mkdir(outputDir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(outputDir, name), contents, "utf8");
    }
  },
};
