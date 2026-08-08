import type { Config } from "./config.js";
import type { DeployRunner } from "./types.js";

/**
 * The outcome of a deploy attempt. Every value is a definite, logged terminal state —
 * `deploy()` is NEVER-THROW, matching the generation/image/storage layers.
 *  - `deployed`         — the command ran and exited 0.
 *  - `failed`           — the command ran and exited non-zero (or the runner threw).
 *  - `skipped-flag`     — `--no-deploy` (deploy not requested).
 *  - `skipped-disabled` — `deploy.enabled` is false in config.
 *  - `refused-empty`    — the render produced no index.html or zero publishable records;
 *                         deploy is refused so a bad run never overwrites a good live site.
 */
export type DeployStatus =
  | "deployed"
  | "skipped-flag"
  | "skipped-disabled"
  | "refused-empty"
  | "failed";

export interface DeployResult {
  status: DeployStatus;
  /** Process exit code, when a command actually ran. */
  code?: number;
  /** Human-readable detail for the summary / logs. */
  detail?: string;
}

/** What the deploy guard inspects: the rendered files + how many records are publishable. */
export interface DeployInput {
  files: Record<string, string>;
  publishableCount: number;
}

export interface DeployDeps {
  run: DeployRunner;
  /** Optional progress logger (defaults to a no-op). */
  log?: (message: string) => void;
}

/**
 * Deploy the rendered site (Slice 8). Shells out to `config.deploy.command` with
 * cwd = `config.deploy.cwd` (default `vercel --prod --yes` in the render output dir).
 * NEVER THROWS — always resolves a DeployResult.
 *
 * The CRITICAL GUARD refuses to deploy an empty/invalid render (no index.html, or zero
 * publishable records) so a failed pipeline run can never nuke the live site over a good
 * one. Refusal is a benign terminal state (`refused-empty`), not an error — a
 * legitimately-empty early cycle simply does not publish.
 */
export async function deploy(
  config: Config,
  input: DeployInput,
  deps: DeployDeps,
  opts: { requested: boolean },
): Promise<DeployResult> {
  const log = deps.log ?? (() => {});

  if (!opts.requested) {
    log("deploy: skipped (--no-deploy)");
    return { status: "skipped-flag" };
  }

  if (!config.deploy.enabled) {
    log("deploy: skipped (deploy.enabled=false)");
    return { status: "skipped-disabled" };
  }

  // GUARD: never deploy an empty/invalid site over the live one.
  const index = input.files["index.html"];
  const hasIndex = typeof index === "string" && index.trim().length > 0;
  if (!hasIndex || input.publishableCount <= 0) {
    log(
      `deploy: REFUSED — empty/invalid render (index.html ${hasIndex ? "present" : "missing"}, ` +
        `${input.publishableCount} publishable). Live site left untouched.`,
    );
    return {
      status: "refused-empty",
      detail: `index.html ${hasIndex ? "present" : "missing"}, publishable=${input.publishableCount}`,
    };
  }

  log(`deploy: running '${config.deploy.command}' in ${config.deploy.cwd}`);

  // Bounded retry: a transient failure (a Vercel hiccup that exits non-zero, or a runner that
  // throws) can strand a fully-rendered site for hours until the next cron re-deploys. Retry
  // `retries` extra times with linear backoff (base, 2×base, …) before giving up. A clean exit 0
  // short-circuits. The render GUARD above ran once — the site doesn't change between attempts.
  const { retries, backoffMs } = config.deploy;
  const tries = 1 + retries;
  let lastCode: number | undefined;
  let threw = false;

  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      const wait = backoffMs * i;
      const priorFail = threw ? "runner threw" : `exit ${lastCode}`;
      log(
        `deploy: attempt ${i}/${tries} failed (${priorFail}) — retrying (attempt ${i + 1}/${tries})` +
          (wait > 0 ? ` in ${Math.round(wait / 1000)}s` : ""),
      );
      if (wait > 0) await delay(wait);
    }

    threw = false;
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await deps.run({ command: config.deploy.command, cwd: config.deploy.cwd });
    } catch {
      // The runner is contractually never-throw, but guard anyway so deploy() never rejects.
      threw = true;
      lastCode = undefined;
      continue;
    }

    lastCode = res.code;
    if (res.code === 0) {
      log(`deploy: succeeded${i > 0 ? ` (attempt ${i + 1}/${tries})` : ""}`);
      return { status: "deployed", code: 0 };
    }
  }

  const reason = threw ? "deploy runner threw" : `exit ${lastCode}`;
  const suffix = tries > 1 ? ` after ${tries} attempts` : "";
  log(`deploy: FAILED${suffix} (${reason})`);
  return { status: "failed", code: lastCode, detail: `failed${suffix} (${reason})` };
}

/** Promise-based delay for retry backoff (kept tiny + injectable-free for testability). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
