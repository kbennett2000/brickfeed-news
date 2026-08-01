import { spawn } from "node:child_process";
import { loadConfig, type Config } from "./config.js";
import { defaultCycleIo, runCycle } from "./cycle.js";
import { createGenerator } from "./generator/index.js";
import { createTextGenerator } from "./generator/text.js";
import { type TtsFailure, resolveTtsUrl } from "./generator/tts.js";
import { createImageProvider } from "./image/index.js";
import { createOpinionTtsDeps } from "./opinions-tts.js";
import { getVercelToken } from "./secrets.js";
import { createStorageProvider } from "./storage/index.js";
import type { CycleDeps, DeployRunner, FetchLike } from "./types.js";

/**
 * CLI entry for the full publish cycle (Slice 8, `npm run cycle`). Loads config.json, wires
 * the real boundaries (fetch, the CONFIGURED providers via their factories, the deploy
 * subprocess, and the filesystem IO), runs ingest → generate → opinions → image → ageout →
 * render → deploy in one process, prints a per-stage summary, and exits non-zero on a hard stage
 * failure (so cron/monitoring catches it). Reads no environment (the secrets guardrail keeps
 * env in secrets.ts; the deploy runner's token comes from getVercelToken()).
 *
 * Flags:
 *   --no-deploy  run every stage but skip the deploy step (for testing on the box)
 *   --dry-run    log intended actions and mutate nothing (no providers, no writes, no deploy)
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = { deploy: !argv.includes("--no-deploy"), dryRun: argv.includes("--dry-run") };

  const config = await loadConfig("config.json");

  // Collect every TTS failure across the run (story-cover, opinion-gate, opinion-image-brief)
  // so a silent Claude failover becomes a LOUD end-of-cycle alarm — the owner asked to KNOW
  // when the LAN TTS box degrades instead of finding out days later.
  const ttsFailures: TtsFailure[] = [];
  const onTtsFailure = (f: TtsFailure) => ttsFailures.push(f);

  // Best-effort self-heal: if TTS is enabled but unreachable at preflight and a restart command
  // is configured, restart it once before the run (the per-call path still fails over + reports).
  if (!opts.dryRun) await ttsPreflight(config, (m) => console.log(m));

  const deps: CycleDeps = {
    now: () => new Date(),
    // Node's global fetch satisfies the structural FetchLike shape.
    fetch: fetch as unknown as FetchLike,
    generator: createGenerator(config, { ttsObserver: onTtsFailure }),
    // Opinions-only text seam (cycle.ts wires it into the opinion stage). Pinned to the
    // opinion model override when set (the columns want a stronger model than story gen).
    textGenerator: createTextGenerator(config, {}, (m) => console.log(m), config.generator.opinionModel),
    opinionTts: createOpinionTtsDeps(config, undefined, onTtsFailure),
    imageProvider: createImageProvider(config),
    storage: createStorageProvider(config),
    deployRun: defaultDeployRunner,
    io: defaultCycleIo,
    log: (message) => console.log(message),
  };

  const result = await runCycle(config, deps, opts);

  const at = new Date().toISOString();
  const head = result.ok
    ? `cycle ${opts.dryRun ? "(dry-run) " : ""}complete`
    : `cycle ABORTED at stage "${result.failedStage}"`;
  console.log(`[${at}] ${head}`);
  for (const [name, summary] of Object.entries(result.stages)) {
    console.log(`  • ${name}: ${summary}`);
  }

  // LOUD TTS-DEGRADED alarm: if any TTS call ultimately failed this run, name the task(s) and the
  // real error code, note we fell back to Claude, and fire a best-effort desktop notification.
  reportTtsDegradation(config, ttsFailures);

  // A hard stage failure exits non-zero; an empty-render deploy refusal stays ok (exit 0).
  process.exitCode = result.ok ? 0 : 1;
}

/** GET {base}/health with a short timeout; true only on a 200. Never throws. */
async function probeTtsHealth(base: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/health`, { signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TTS preflight self-heal (owner directive 2026-07-14). When TTS is enabled but the endpoint is
 * unreachable at cycle start AND a `restartCommand` is configured, run it ONCE, wait briefly, and
 * re-probe — logging the outcome. Opt-in: with no restartCommand we do nothing here (the per-call
 * path still fails over to Claude and the end-of-cycle alarm still reports the degradation). A
 * restart is NOT attempted for 503 busy/model_unavailable (the service is reachable then — a
 * restart wouldn't help and would disrupt other apps sharing it).
 */
async function ttsPreflight(config: Config, log: (m: string) => void): Promise<void> {
  const tts = config.generator.tts;
  const enabled = !!tts && (tts.storyCover || tts.opinionGate || tts.opinionImageBrief);
  if (!tts || !enabled || !tts.restartCommand) return;

  const base = resolveTtsUrl(tts.url).replace(/\/+$/, "");
  if (await probeTtsHealth(base)) return;

  const at = () => new Date().toISOString();
  log(`[${at()}] cycle: TTS preflight — ${base} unreachable; running restart once: ${tts.restartCommand}`);
  const ran = await new Promise<boolean>((resolve) => {
    const child = spawn(tts.restartCommand as string, { shell: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  await new Promise((r) => setTimeout(r, 3000)); // give the service a moment to come up
  const backUp = await probeTtsHealth(base);
  log(
    `[${at()}] cycle: TTS preflight — restart ${ran ? "ran" : "FAILED (non-zero/could not spawn)"}; ` +
      `service ${backUp ? "reachable now" : "STILL unreachable → tasks will fail over to Claude"}`,
  );
}

/** Compact "task (codes, Nx)" summary of the collected TTS failures, grouped by task. */
function summarizeTtsFailures(failures: TtsFailure[]): string {
  const byTask = new Map<string, { count: number; codes: Set<string> }>();
  for (const f of failures) {
    const e = byTask.get(f.task) ?? { count: 0, codes: new Set<string>() };
    e.count += 1;
    e.codes.add(f.code);
    byTask.set(f.task, e);
  }
  return [...byTask]
    .map(([task, e]) => `${task} (${[...e.codes].join("/")}, ${e.count}×)`)
    .join("; ");
}

/**
 * Raise the loud TTS-DEGRADED alarm when any TTS call failed this run: a greppable stderr line
 * (mirrors the OPINION-STALE convention) + a best-effort `notify-send` desktop popup so the owner
 * finds out immediately rather than by reading logs. Both degrade silently if unavailable.
 */
function reportTtsDegradation(config: Config, failures: TtsFailure[]): void {
  if (failures.length === 0) return;
  const summary = summarizeTtsFailures(failures);
  const base = config.generator.tts ? resolveTtsUrl(config.generator.tts.url) : "(unknown)";
  const line =
    `TTS-DEGRADED — ${summary}; fell back to Claude this run. ` +
    `text-transform-service at ${base} needs attention.`;
  console.warn(`[${new Date().toISOString()}] cycle: ⚠ ${line}`);

  // Desktop notification — best-effort. From cron this needs DISPLAY + DBUS_SESSION_BUS_ADDRESS
  // in the environment (see docs); interactively it just works. Never blocks or throws.
  try {
    const child = spawn("notify-send", ["Brickfeed: TTS degraded", line], { stdio: "ignore" });
    child.on("error", () => {});
  } catch {
    /* notify-send absent — the greppable line above is the durable signal. */
  }
}

/**
 * Default deploy runner: shell out to the configured command in `cwd`, never throw. If a
 * VERCEL_TOKEN is present (CI-like contexts), append it as `--token` — routed through
 * secrets.ts so this is the only place env touches deploy; the box normally authenticates
 * via a one-time `vercel login` and leaves the token unset.
 */
const defaultDeployRunner: DeployRunner = ({ command, cwd }) =>
  new Promise((resolve) => {
    const token = getVercelToken();
    const fullCommand = token ? `${command} --token ${token}` : command;

    const child = spawn(fullCommand, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", () => resolve({ code: 1, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

main().catch((err) => {
  console.error("cycle failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
