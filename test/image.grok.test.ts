import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokImageProvider, extractImageUrl } from "../src/image/grok.js";
import { bytes, fakeImageRunner } from "./helpers.js";

const BASE = "https://img.test/v1";
const GEN_URL = `${BASE}/images/generations`;
const IMG_URL = "https://cdn.img.test/abc.png";
const PNG = bytes("\x89PNG...fake-image-bytes...");
const PROMPT = "TEST-STYLE diorama. Scene: a grinning mayor on an oversized bus.";

/** An envelope body as the images-generations endpoint returns it. */
const envelope = (url: string) => bytes(JSON.stringify({ data: [{ url }] }));

function provider(runner: ReturnType<typeof fakeImageRunner>): GrokImageProvider {
  return new GrokImageProvider({
    baseUrl: BASE,
    model: "img-test",
    aspectRatio: "1:1",
    resolution: "1k",
    runner,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GrokImageProvider.generate — happy path", () => {
  it("posts the prompt, follows the ephemeral url, and returns the downloaded bytes", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({
      routes: {
        [`POST ${GEN_URL}`]: { bytes: envelope(IMG_URL) },
        [`GET ${IMG_URL}`]: { bytes: PNG },
      },
    });

    const out = await provider(runner).generate(PROMPT);
    expect(out).toEqual(PNG);

    // Step 1: POST /images/generations with auth + the prompt + params, unchanged.
    const post = runner.calls[0];
    expect(post.method).toBe("POST");
    expect(post.url).toBe(GEN_URL);
    expect(post.headers?.authorization).toBe("Bearer test-key");
    const body = JSON.parse(post.body ?? "{}");
    expect(body.prompt).toBe(PROMPT);
    expect(body.model).toBe("img-test");
    expect(body.aspect_ratio).toBe("1:1");
    expect(body.resolution).toBe("1k");

    // Step 2: GET the ephemeral url the envelope handed back.
    const get = runner.calls[1];
    expect(get.method).toBe("GET");
    expect(get.url).toBe(IMG_URL);
  });
});

describe("GrokImageProvider.generate — never-throw failure modes", () => {
  it("returns null when the API key is missing (runner never called)", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const runner = fakeImageRunner({ routes: { [`POST ${GEN_URL}`]: { bytes: envelope(IMG_URL) } } });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("returns null on a non-ok generations response", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({ routes: { [`POST ${GEN_URL}`]: { ok: false, status: 429 } } });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });

  it("returns null when the runner throws (transport failure)", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({ throws: true });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });

  it("returns null when the envelope isn't valid JSON", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({ routes: { [`POST ${GEN_URL}`]: { bytes: bytes("<html>oops</html>") } } });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });

  it("returns null when the envelope has no image url", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({ routes: { [`POST ${GEN_URL}`]: { bytes: bytes(JSON.stringify({ data: [] })) } } });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });

  it("returns null when the ephemeral download is non-ok", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const runner = fakeImageRunner({
      routes: {
        [`POST ${GEN_URL}`]: { bytes: envelope(IMG_URL) },
        [`GET ${IMG_URL}`]: { ok: false, status: 404 },
      },
    });
    expect(await provider(runner).generate(PROMPT)).toBeNull();
  });
});

describe("extractImageUrl", () => {
  it("pulls data[0].url out of the envelope", () => {
    expect(extractImageUrl(envelope(IMG_URL))).toBe(IMG_URL);
  });

  it("returns null on empty / non-JSON / missing structure", () => {
    expect(extractImageUrl(new Uint8Array(0))).toBeNull();
    expect(extractImageUrl(bytes("not json"))).toBeNull();
    expect(extractImageUrl(bytes(JSON.stringify({ data: [] })))).toBeNull();
    expect(extractImageUrl(bytes(JSON.stringify({ data: [{ url: 42 }] })))).toBeNull();
    expect(extractImageUrl(bytes(JSON.stringify({})))).toBeNull();
  });
});
