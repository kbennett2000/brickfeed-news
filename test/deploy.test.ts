import { describe, expect, it } from "vitest";
import { deploy } from "../src/deploy.js";
import { fakeDeployRunner, makeConfig } from "./helpers.js";

/** A minimal "valid render": an index.html with content + at least one publishable record. */
const OK_INPUT = { files: { "index.html": "<!doctype html><main>hi</main>" }, publishableCount: 3 };

describe("deploy — runs the configured command", () => {
  it("returns 'deployed' on exit 0 and passes command + cwd", async () => {
    const run = fakeDeployRunner({ code: 0 });
    const config = makeConfig({
      deploy: { command: "vercel --prod --yes", cwd: "out-dir", enabled: true },
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
      deploy: { command: "vercel --prod --yes", cwd: "site", enabled: false },
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
