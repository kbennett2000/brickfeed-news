import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { defaultCycleIo, runCycle } from "./cycle.js";
import { createGenerator } from "./generator/index.js";
import { createImageProvider } from "./image/index.js";
import { getVercelToken } from "./secrets.js";
import { createStorageProvider } from "./storage/index.js";
import type { CycleDeps, DeployRunner, FetchLike } from "./types.js";

/**
 * CLI entry for the full publish cycle (Slice 8, `npm run cycle`). Loads config.json, wires
 * the real boundaries (fetch, the CONFIGURED providers via their factories, the deploy
 * subprocess, and the filesystem IO), runs ingest → generate → image → ageout → render →
 * deploy in one process, prints a per-stage summary, and exits non-zero on a hard stage
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

  const deps: CycleDeps = {
    now: () => new Date(),
    // Node's global fetch satisfies the structural FetchLike shape.
    fetch: fetch as unknown as FetchLike,
    generator: createGenerator(config),
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

  // A hard stage failure exits non-zero; an empty-render deploy refusal stays ok (exit 0).
  process.exitCode = result.ok ? 0 : 1;
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
