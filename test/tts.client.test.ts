import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TTS_GATE_TIMEOUT_MS,
  DEFAULT_TTS_TIMEOUT_MS,
  defaultTtsRunner,
  TtsClient,
  type TtsFailure,
  type TtsHttpRunner,
} from "../src/generator/tts.js";
import { ttsGateVerdicts } from "../src/opinions-tts.js";
import type { ManifestRecord } from "../src/types.js";
import { fakeTtsRunner, ttsErr, ttsOk } from "./helpers.js";

describe("TtsClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to /v1/transform/{name} with a {text, options} body and returns the output", async () => {
    const runner = fakeTtsRunner({
      routes: { "story-cover": { body: ttsOk({ headline: "H" }) } },
    });
    const client = new TtsClient("http://tts.test", runner);

    const res = await client.run("story-cover", "some text");

    expect(res).toEqual({ ok: true, output: { headline: "H" } });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].url).toBe("http://tts.test/v1/transform/story-cover");
    expect(JSON.parse(runner.calls[0].body)).toEqual({ text: "some text", options: {} });
  });

  it("strips a trailing slash from the configured url", async () => {
    const runner = fakeTtsRunner({ routes: { "story-cover": { body: ttsOk({}) } } });
    await new TtsClient("http://tts.test/", runner).run("story-cover", "t");
    expect(runner.calls[0].url).toBe("http://tts.test/v1/transform/story-cover");
  });

  it("retries a failed call and succeeds on a later attempt (owner directive: try once or twice)", async () => {
    let n = 0;
    const runner: TtsHttpRunner = async () => {
      n += 1;
      return n < 2
        ? { ok: false, status: 503, body: ttsErr("busy") }
        : { ok: true, status: 200, body: ttsOk({ headline: "H" }) };
    };
    const res = await new TtsClient("http://tts.test", runner, undefined, {
      retries: 1,
      backoffMs: 0,
    }).run("story-cover", "t");

    expect(n).toBe(2); // first try failed (busy), retry succeeded
    expect(res).toEqual({ ok: true, output: { headline: "H" } });
  });

  it("notifies the observer ONCE on a final failure, with the attempt count and code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failures: TtsFailure[] = [];
    const runner: TtsHttpRunner = async () => ({ ok: false, status: 503, body: ttsErr("busy") });

    const res = await new TtsClient("http://tts.test", runner, undefined, {
      retries: 2,
      backoffMs: 0,
      onFailure: (f) => failures.push(f),
    }).run("story-cover", "t");

    expect(res).toEqual({ ok: false, status: 503, code: "busy" });
    // Three tries (1 + 2 retries), but exactly ONE warning and ONE observer event — the signal.
    expect(failures).toEqual([{ task: "story-cover", status: 503, code: "busy", attempts: 3 }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 413, 422, 503, 500])(
    "returns a typed failure and warns once on HTTP %i",
    async (status) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runner = fakeTtsRunner({
        routes: { "opinion-gate": { ok: false, status, body: ttsErr("some_code") } },
      });

      const res = await new TtsClient("http://tts.test", runner).run("opinion-gate", "t");

      expect(res).toEqual({ ok: false, status, code: "some_code" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("task=opinion-gate");
      expect(warn.mock.calls[0][0]).toContain(`status=${status}`);
      expect(warn.mock.calls[0][0]).toContain("code=some_code");
    },
  );

  it("treats a transport failure (runner throws) as unreachable, status 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fakeTtsRunner({ throws: true });

    const res = await new TtsClient("http://tts.test", runner).run("story-cover", "t");

    expect(res).toEqual({ ok: false, status: 0, code: "unreachable" });
    expect(warn.mock.calls[0][0]).toContain("code=unreachable");
  });

  it("treats a 200 with a malformed / non-object envelope as a bad_envelope failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fakeTtsRunner({
      routes: {
        "story-cover": { body: "not json" },
        "opinion-gate": { body: JSON.stringify({ output: "not-an-object" }) },
      },
    });
    const client = new TtsClient("http://tts.test", runner);

    expect(await client.run("story-cover", "t")).toEqual({
      ok: false,
      status: 200,
      code: "bad_envelope",
    });
    expect(await client.run("opinion-gate", "t")).toEqual({
      ok: false,
      status: 200,
      code: "bad_envelope",
    });
  });

  it("falls back to code 'error' when a non-200 body has no parseable error code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fakeTtsRunner({
      routes: { "story-cover": { ok: false, status: 500, body: "<html>oops</html>" } },
    });
    const res = await new TtsClient("http://tts.test", runner).run("story-cover", "t");
    expect(res).toEqual({ ok: false, status: 500, code: "error" });
  });
});

describe("TtsClient — per-task timeout budget (ADR-0021 amendment)", () => {
  it("passes the gate's 120s default and the shared 30s default to the runner per task", async () => {
    const runner = fakeTtsRunner({
      routes: {
        "opinion-gate": { body: ttsOk({ verdicts: [] }) },
        "story-cover": { body: ttsOk({}) },
        "opinion-image-brief": { body: ttsOk({}) },
      },
    });
    const client = new TtsClient("http://tts.test", runner);

    await client.run("opinion-gate", "t");
    await client.run("story-cover", "t");
    await client.run("opinion-image-brief", "t");

    expect(runner.calls[0].timeoutMs).toBe(DEFAULT_TTS_GATE_TIMEOUT_MS); // 120_000
    expect(runner.calls[1].timeoutMs).toBe(DEFAULT_TTS_TIMEOUT_MS); // 30_000
    expect(runner.calls[2].timeoutMs).toBe(DEFAULT_TTS_TIMEOUT_MS); // brief shares the default
  });

  it("lets a config override win per task, leaving other tasks on the code default", async () => {
    const runner = fakeTtsRunner({
      routes: { "opinion-gate": { body: ttsOk({ verdicts: [] }) }, "story-cover": { body: ttsOk({}) } },
    });
    const client = new TtsClient("http://tts.test", runner, { "opinion-gate": 5_000 });

    await client.run("opinion-gate", "t");
    await client.run("story-cover", "t");

    expect(runner.calls[0].timeoutMs).toBe(5_000); // override wins
    expect(runner.calls[1].timeoutMs).toBe(DEFAULT_TTS_TIMEOUT_MS); // untouched
  });
});

/**
 * Abort behavior of the REAL `defaultTtsRunner` under a per-task budget. Fake timers + a stubbed
 * fetch that honors the AbortSignal: a response inside the budget resolves; one past it aborts to
 * the fail-closed shape (ok:false, status 0) — which, through the gate adapter, excludes all.
 */
describe("defaultTtsRunner — honors the resolved timeout budget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A fetch that resolves 200 after `responseDelayMs`, or rejects the moment its signal aborts. */
  function fakeFetch(responseDelayMs: number, body: string) {
    return (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ ok: true, status: 200, text: async () => body }),
          responseDelayMs,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
  }

  it("resolves ok when the response lands (45s) inside the gate's 120s budget", async () => {
    vi.useFakeTimers();
    const body = ttsOk({ verdicts: [] });
    vi.stubGlobal("fetch", fakeFetch(45_000, body));

    const p = defaultTtsRunner({ url: "http://tts.test/v1/transform/opinion-gate", body: "{}", timeoutMs: DEFAULT_TTS_GATE_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(45_000);

    expect(await p).toEqual({ ok: true, status: 200, body });
  });

  it("aborts to fail-closed (ok:false, status 0) when the response (125s) exceeds the 120s budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fakeFetch(125_000, ttsOk({ verdicts: [] })));

    const p = defaultTtsRunner({ url: "http://tts.test/v1/transform/opinion-gate", body: "{}", timeoutMs: DEFAULT_TTS_GATE_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(DEFAULT_TTS_GATE_TIMEOUT_MS);

    expect(await p).toEqual({ ok: false, status: 0, body: "" });
  });

  it("an over-budget gate call flows through the gate adapter to ALL EXCLUDED (fail-closed)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fakeFetch(125_000, ttsOk({ verdicts: [] })));

    const candidates = [
      { id: "a", headline: "Harmless local bake sale", description: "" },
      { id: "b", headline: "Town plants new trees", description: "" },
    ] as unknown as ManifestRecord[];
    const client = new TtsClient("http://tts.test", defaultTtsRunner);

    const p = ttsGateVerdicts(client, candidates);
    await vi.advanceTimersByTimeAsync(DEFAULT_TTS_GATE_TIMEOUT_MS);
    const verdicts = await p;

    // null == fail-closed sentinel: the caller excludes every candidate for the cycle.
    expect(verdicts).toBeNull();
  });
});
