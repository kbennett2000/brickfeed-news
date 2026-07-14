import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsClient } from "../src/generator/tts.js";
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
