import { describe, expect, it } from "vitest";
import { GrokGenerator, extractChatContent } from "../src/generator/grok.js";
import type { GenerationInput } from "../src/types.js";
import { fakeGrokRunner } from "./helpers.js";

const INPUT: GenerationInput = {
  title: "Mayor unveils new transit plan",
  sourceName: "The Metro Times",
  url: "https://example.com/transit",
};

const INNER = {
  headline: "City reveals ambitious transit overhaul",
  description: "The mayor outlined a plan to expand bus routes. Funding details follow.",
  imagePrompt: "A grinning mayor rides a wildly oversized bouncing bus through downtown.",
  category: "POLITICS",
  caption: "A beaming official rides a comically enormous bouncing bus downtown.",
};

/** Wrap inner text in an OpenAI-compatible chat-completions envelope. */
function envelope(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "grok-test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function grok(runnerOpts: Parameters<typeof fakeGrokRunner>[0]): GrokGenerator {
  return new GrokGenerator({
    baseUrl: "https://grok.test/v1",
    model: "grok-test",
    runner: fakeGrokRunner(runnerOpts),
  });
}

describe("GrokGenerator.generate — happy path", () => {
  it("parses the chat envelope -> inner JSON -> normalized output", async () => {
    const gen = grok({ body: envelope(JSON.stringify(INNER)) });
    expect(await gen.generate(INPUT)).toEqual(INNER);
  });
});

describe("GrokGenerator.generate — defensive inner parse", () => {
  const variants: Record<string, string> = {
    "```json fenced": "```json\n" + JSON.stringify(INNER) + "\n```",
    "bare ``` fenced": "```\n" + JSON.stringify(INNER) + "\n```",
    "leading + trailing prose": `Sure! Here is the JSON:\n${JSON.stringify(INNER)}\nEnjoy.`,
    "surrounding whitespace": `\n\n   ${JSON.stringify(INNER)}   \n`,
    "pretty-printed": JSON.stringify(INNER, null, 2),
  };

  for (const [name, content] of Object.entries(variants)) {
    it(`recovers the object from: ${name}`, async () => {
      const gen = grok({ body: envelope(content) });
      expect(await gen.generate(INPUT)).toEqual(INNER);
    });
  }
});

describe("GrokGenerator.generate — never-throw failure modes", () => {
  it("returns null on a non-ok HTTP response", async () => {
    const gen = grok({ body: envelope(JSON.stringify(INNER)), ok: false, status: 429 });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when the runner throws (transport failure)", async () => {
    const gen = grok({ throws: true });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null on an unparseable response body", async () => {
    const gen = grok({ body: "<html>gateway timeout</html>" });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when the envelope has no choices", async () => {
    const gen = grok({ body: JSON.stringify({ choices: [] }) });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when the message content isn't valid inner JSON", async () => {
    const gen = grok({ body: envelope("no object at all here") });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when a required key is missing from the inner JSON", async () => {
    const gen = grok({
      body: envelope(JSON.stringify({ headline: "h", description: "d" })),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when caption is missing (caption is required)", async () => {
    const { caption, ...noCaption } = INNER;
    const gen = grok({ body: envelope(JSON.stringify(noCaption)) });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null on an empty body", async () => {
    const gen = grok({ body: "" });
    expect(await gen.generate(INPUT)).toBeNull();
  });
});

describe("GrokGenerator.generate — category normalization (Slice 6)", () => {
  it("normalizes an invalid category to WORLD (story still generates)", async () => {
    const gen = grok({
      body: envelope(JSON.stringify({ ...INNER, category: "GOSSIP" })),
    });
    expect(await gen.generate(INPUT)).toEqual({ ...INNER, category: "WORLD" });
  });

  it("normalizes a missing category to WORLD", async () => {
    const { category, ...noCategory } = INNER;
    const gen = grok({ body: envelope(JSON.stringify(noCategory)) });
    expect(await gen.generate(INPUT)).toEqual({ ...INNER, category: "WORLD" });
  });

  it("accepts a lowercase category, upcasing it", async () => {
    const gen = grok({
      body: envelope(JSON.stringify({ ...INNER, category: "politics" })),
    });
    expect(await gen.generate(INPUT)).toEqual({ ...INNER, category: "POLITICS" });
  });
});

describe("extractChatContent", () => {
  it("pulls choices[0].message.content out of the envelope", () => {
    expect(extractChatContent(envelope("hello"))).toBe("hello");
  });

  it("returns null on empty / non-JSON / missing structure", () => {
    expect(extractChatContent("")).toBeNull();
    expect(extractChatContent("not json")).toBeNull();
    expect(extractChatContent(JSON.stringify({ choices: [{}] }))).toBeNull();
    expect(
      extractChatContent(JSON.stringify({ choices: [{ message: { content: 42 } }] })),
    ).toBeNull();
  });
});
