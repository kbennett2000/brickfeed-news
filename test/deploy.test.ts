import { describe, expect, it } from "vitest";
import { deploy } from "../src/deploy.js";
import { fakeDeployRunner, makeConfig } from "./helpers.js";

/** A minimal "valid render": an index.html with content + at least one publishable record. */
const OK_INPUT = { files: { "index.html": "<!doctype html><main>hi</main>" }, publishableCount: 3 };

describe("deploy — runs the configured command", () => {
  it("returns 'deployed' on exit 0 and passes command + cwd", async () => {
    const run = fakeDeployRunner({ code: 0 });
    const config = makeConfig({
      deploy: { command: "vercel --prod --yes", cwd: "out-dir", enabled: true, retries: 0, backoffMs: 0 },
    });
    const result = await deploy(config, OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("deployed");
    expect(run.calls).toEqual([{ command: "vercel --prod --yes", cwd: "out-dir" }]);
  });

  it("returns 'failed' on a non-zero exit code", async () => {
    const run = fakeDeployRunner({ code: 2 });
    const result = await deploy(makeConfig(), OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("failed");
    expect(result.code).toBe(2);
  });

  it("never throws when the runner rejects (→ failed)", async () => {
    const run = fakeDeployRunner({ throws: true });
    const result = await deploy(makeConfig(), OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("failed");
    expect(run.calls).toHaveLength(1);
  });
});

describe("deploy — bounded retry on transient failure (ADR-0030)", () => {
  /** A runner that returns each queued outcome in turn (an exit code, or "throw"), then repeats
   *  the last. Records every call so tests can assert how many attempts were made. */
  function sequenceRunner(...outcomes: (number | "throw")[]) {
    const calls: { command: string; cwd: string }[] = [];
    let i = 0;
    const runner = async (a: { command: string; cwd: string }) => {
      calls.push(a);
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      if (o === "throw") throw new Error("simulated deploy spawn failure");
      return { code: o, stdout: "", stderr: "" };
    };
    return Object.assign(runner, { calls });
  }

  const withRetry = (retries: number) =>
    makeConfig({
      deploy: { command: "vercel --prod --yes", cwd: "site", enabled: true, retries, backoffMs: 0 },
    });

  it("retries a non-zero exit and succeeds on the second attempt", async () => {
    const run = sequenceRunner(1, 0);
    const result = await deploy(withRetry(2), OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("deployed");
    expect(run.calls).toHaveLength(2);
  });

  it("retries a thrown runner and succeeds on the second attempt", async () => {
    const run = sequenceRunner("throw", 0);
    const result = await deploy(withRetry(2), OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("deployed");
    expect(run.calls).toHaveLength(2);
  });

  it("exhausts all attempts then reports failed with the attempt count", async () => {
    const run = sequenceRunner(1);
    const result = await deploy(withRetry(2), OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("failed");
    expect(result.code).toBe(1);
    expect(run.calls).toHaveLength(3); // 1 + 2 retries
    expect(result.detail).toContain("3 attempts");
  });

  it("retries: 0 is one-shot (opt-out preserved)", async () => {
    const run = sequenceRunner(1);
    const result = await deploy(withRetry(0), OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("failed");
    expect(run.calls).toHaveLength(1);
  });
});

describe("deploy — skips", () => {
  it("skipped-flag when not requested (--no-deploy); runner not called", async () => {
    const run = fakeDeployRunner();
    const result = await deploy(makeConfig(), OK_INPUT, { run }, { requested: false });
    expect(result.status).toBe("skipped-flag");
    expect(run.calls).toHaveLength(0);
  });

  it("skipped-disabled when deploy.enabled is false; runner not called", async () => {
    const run = fakeDeployRunner();
    const config = makeConfig({
      deploy: { command: "vercel --prod --yes", cwd: "site", enabled: false, retries: 0, backoffMs: 0 },
    });
    const result = await deploy(config, OK_INPUT, { run }, { requested: true });
    expect(result.status).toBe("skipped-disabled");
    expect(run.calls).toHaveLength(0);
  });
});

describe("deploy — empty/invalid render GUARD", () => {
  it("refuses when index.html is missing; runner not called", async () => {
    const run = fakeDeployRunner();
    const result = await deploy(
      makeConfig(),
      { files: { "styles.css": "x" }, publishableCount: 3 },
      { run },
      { requested: true },
    );
    expect(result.status).toBe("refused-empty");
    expect(run.calls).toHaveLength(0);
  });

  it("refuses when index.html is blank; runner not called", async () => {
    const run = fakeDeployRunner();
    const result = await deploy(
      makeConfig(),
      { files: { "index.html": "   " }, publishableCount: 3 },
      { run },
      { requested: true },
    );
    expect(result.status).toBe("refused-empty");
    expect(run.calls).toHaveLength(0);
  });

  it("refuses when there are zero publishable records; runner not called", async () => {
    const run = fakeDeployRunner();
    const result = await deploy(
      makeConfig(),
      { files: { "index.html": "<main>empty state</main>" }, publishableCount: 0 },
      { run },
      { requested: true },
    );
    expect(result.status).toBe("refused-empty");
    expect(run.calls).toHaveLength(0);
  });
});
