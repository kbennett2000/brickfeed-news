import { describe, expect, it } from "vitest";
import { LocalImageProvider } from "../src/image/local.js";
import { bytes, fakeImageRunner } from "./helpers.js";

const URL = "http://imagegen.test";
const GEN_URL = `${URL}/generate`;
const PNG = bytes("\x89PNG...local-image-bytes...");
const PROMPT = "TEST-STYLE diorama. Scene: a senator juggling flaming budgets.";

function provider(runner: ReturnType<typeof fakeImageRunner>): LocalImageProvider {
  return new LocalImageProvider({ url: URL, style: "test-base", runner });
}

describe("LocalImageProvider.generate", () => {
  it("posts wrappedPrompt + base style and returns the PNG bytes", async () => {
    const runner = fakeImageRunner({ routes: { [`POST ${GEN_URL}`]: { bytes: PNG } } });

    const out = await provider(runner).generate(PROMPT);
    expect(out).toEqual(PNG);

    const post = runner.calls[0];
    expect(post.method).toBe("POST");
    expect(post.url).toBe(GEN_URL);
    const body = JSON.parse(post.body ?? "{}");
    expect(body.prompt).toBe(PROMPT);
    expect(body.style).toBe("test-base");
  });

  it("returns null when the service is unreachable (non-ok)", async () => {
    const runner = fakeImageRunner({ routes: { [`POST ${GEN_URL}`]: { ok: false, status: 502 } } });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });

  it("returns null when the runner throws (connection refused)", async () => {
    const runner = fakeImageRunner({ throws: true });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });
});
