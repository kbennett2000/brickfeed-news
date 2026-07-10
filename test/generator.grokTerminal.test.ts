import { describe, expect, it } from "vitest";
import { GrokTerminalGenerator } from "../src/generator/grokTerminal.js";
import type { GenerationInput } from "../src/types.js";
import { fakeTerminalTextRunner } from "./helpers.js";

const INPUT: GenerationInput = {
  title: "Mayor unveils new transit plan",
  sourceName: "The Metro Times",
  url: "https://example.com/transit",
};

const INNER = {
  headline: "City reveals ambitious transit overhaul",
  description: "The mayor outlined a plan to expand bus routes. Funding details follow.",
  imagePrompt: "A mayor speaks at a podium beside a city bus under bright daylight.",
  category: "POLITICS",
  caption: "An official speaks at a podium beside a bus in bright daylight.",
};

function gen(runner: ReturnType<typeof fakeTerminalTextRunner>) {
  return new GrokTerminalGenerator({ command: "grok", args: ["gen"], runner });
}

describe("GrokTerminalGenerator.generate — happy path", () => {
  it("parses bare JSON stdout into normalized output", async () => {
    const runner = fakeTerminalTextRunner({ stdout: JSON.stringify(INNER) });
    expect(await gen(runner).generate(INPUT)).toEqual(INNER);
  });

  it("recovers the object from fenced / prose-wrapped stdout", async () => {
    const runner = fakeTerminalTextRunner({
      stdout: "Sure!\n```json\n" + JSON.stringify(INNER) + "\n```\nHope that helps.",
    });
    expect(await gen(runner).generate(INPUT)).toEqual(INNER);
  });

  it("normalizes an invalid category to WORLD", async () => {
    const runner = fakeTerminalTextRunner({
      stdout: JSON.stringify({ ...INNER, category: "TABLOID" }),
    });
    expect(await gen(runner).generate(INPUT)).toEqual({ ...INNER, category: "WORLD" });
  });

  it("passes the configured command + args to the runner", async () => {
    const runner = fakeTerminalTextRunner({ stdout: JSON.stringify(INNER) });
    await gen(runner).generate(INPUT);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("grok");
    expect(runner.calls[0].args).toEqual(["gen"]);
    expect(runner.calls[0].prompt).toContain(INPUT.title);
  });
});

describe("GrokTerminalGenerator.generate — never-throw failure modes", () => {
  it("returns null on a non-zero exit code", async () => {
    const runner = fakeTerminalTextRunner({ stdout: JSON.stringify(INNER), code: 1 });
    expect(await gen(runner).generate(INPUT)).toBeNull();
  });

  it("returns null when the runner throws (spawn failure)", async () => {
    const runner = fakeTerminalTextRunner({ throws: true });
    expect(await gen(runner).generate(INPUT)).toBeNull();
  });

  it("returns null on empty stdout", async () => {
    const runner = fakeTerminalTextRunner({ stdout: "" });
    expect(await gen(runner).generate(INPUT)).toBeNull();
  });

  it("returns null when a required key is missing", async () => {
    const { caption, ...noCaption } = INNER;
    const runner = fakeTerminalTextRunner({ stdout: JSON.stringify(noCaption) });
    expect(await gen(runner).generate(INPUT)).toBeNull();
  });
});
