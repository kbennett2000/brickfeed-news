import { describe, expect, it } from "vitest";
import {
  SubscriptionGenerator,
  extractJsonObject,
  extractResultText,
  parseGeneratorOutput,
} from "../src/generator/subscription.js";
import type { GenerationInput } from "../src/types.js";
import { fakeRunner } from "./helpers.js";

const INPUT: GenerationInput = {
  title: "Mayor unveils new transit plan",
  sourceName: "The Metro Times",
  url: "https://example.com/transit",
};

const INNER = {
  headline: "City reveals ambitious transit overhaul",
  description: "The mayor outlined a plan to expand bus routes. Funding details follow.",
  imagePrompt: "A mayor speaks at a podium beside a city bus under bright daylight.",
};

/** Wrap inner text in the `--output-format json` envelope the CLI emits. */
function envelope(resultText: string, isError = false): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: isError,
    result: resultText,
    session_id: "abc",
  });
}

describe("SubscriptionGenerator.generate — happy path", () => {
  it("parses envelope -> inner JSON -> normalized output", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({ stdout: envelope(JSON.stringify(INNER)) }),
    });
    const out = await gen.generate(INPUT);
    expect(out).toEqual(INNER);
  });
});

describe("SubscriptionGenerator.generate — defensive inner parse", () => {
  const variants: Record<string, string> = {
    "```json fenced": "```json\n" + JSON.stringify(INNER) + "\n```",
    "bare ``` fenced": "```\n" + JSON.stringify(INNER) + "\n```",
    "leading + trailing prose": `Sure! Here is the JSON you asked for:\n${JSON.stringify(
      INNER,
    )}\nHope that helps.`,
    "surrounding whitespace": `\n\n   ${JSON.stringify(INNER)}   \n`,
    "pretty-printed": JSON.stringify(INNER, null, 2),
  };

  for (const [name, inner] of Object.entries(variants)) {
    it(`recovers the object from: ${name}`, async () => {
      const gen = new SubscriptionGenerator({
        model: "test-model",
        runner: fakeRunner({ stdout: envelope(inner) }),
      });
      expect(await gen.generate(INPUT)).toEqual(INNER);
    });
  }
});

describe("SubscriptionGenerator.generate — never-throw failure modes", () => {
  it("returns null on a non-zero exit code", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({ stdout: envelope(JSON.stringify(INNER)), code: 1 }),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when the runner throws (spawn failure)", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({ throws: true }),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when the envelope reports is_error", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({ stdout: envelope("boom", true) }),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null on unparseable inner text", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({ stdout: envelope("not json, no braces at all") }),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null when a required key is missing", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({
        stdout: envelope(JSON.stringify({ headline: "h", description: "d" })),
      }),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });

  it("returns null on empty stdout", async () => {
    const gen = new SubscriptionGenerator({
      model: "test-model",
      runner: fakeRunner({ stdout: "" }),
    });
    expect(await gen.generate(INPUT)).toBeNull();
  });
});

describe("parsing helpers", () => {
  it("extractResultText pulls result out of the envelope", () => {
    expect(extractResultText(envelope("hello"))).toBe("hello");
  });

  it("extractResultText falls back to raw stdout when it isn't the envelope", () => {
    expect(extractResultText('{"headline":"h"}')).toBe('{"headline":"h"}');
    expect(extractResultText("plain text")).toBe("plain text");
  });

  it("extractResultText returns null on is_error / empty", () => {
    expect(extractResultText(envelope("x", true))).toBeNull();
    expect(extractResultText("   ")).toBeNull();
  });

  it("extractJsonObject strips fences and isolates the object", () => {
    expect(extractJsonObject("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(extractJsonObject("prefix {\"a\":1} suffix")).toBe('{"a":1}');
    expect(extractJsonObject("no object here")).toBeNull();
  });

  it("parseGeneratorOutput trims strings and rejects blanks", () => {
    expect(
      parseGeneratorOutput(
        JSON.stringify({ headline: "  h  ", description: "d", imagePrompt: "p" }),
      ),
    ).toEqual({ headline: "h", description: "d", imagePrompt: "p" });
    expect(
      parseGeneratorOutput(
        JSON.stringify({ headline: "  ", description: "d", imagePrompt: "p" }),
      ),
    ).toBeNull();
  });
});
