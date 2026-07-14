import { describe, expect, it, vi } from "vitest";
import { wrapBrickStyle } from "../src/brick.js";
import type { Config } from "../src/config.js";
import { GrokGenerator, createGenerator } from "../src/generator/index.js";
import {
  TtsClient,
  TtsFailoverGenerator,
  buildStoryCoverInput,
  createTtsStoryGenerator,
} from "../src/generator/tts.js";
import type { GenerationInput, Generator, GeneratorOutput } from "../src/types.js";
import { fakeGenerator, fakeTtsRunner, makeConfig, ttsErr, ttsOk } from "./helpers.js";

const INPUT: GenerationInput = { title: "Bees swarm city hall", sourceName: "Metro Herald", url: "https://x/1" };

const COVER = {
  headline: "City hall abuzz as bees move in",
  description: "A swarm of bees settled on the city hall steps, delighting onlookers and briefly delaying meetings.",
  imagePrompt: "A cheerful swarm of plump bees circles a grand stone building while officials wave paper fans",
  category: "WORLD",
  caption: "Bees drift around a grand stone building as officials wave fans",
};

/** A config with the story-cover task routed to TTS. */
function ttsConfig(over: Partial<Config["generator"]["tts"]> = {}): Config {
  const c = makeConfig();
  c.generator.tts = { url: "http://tts.test", storyCover: true, opinionGate: false, opinionImageBrief: false, ...over };
  return c;
}

describe("story-cover TTS adapter", () => {
  it("builds the source-context block as the transform input", () => {
    expect(buildStoryCoverInput(INPUT)).toBe(
      "Source article title: Bees swarm city hall\nPublisher: Metro Herald\nSource URL: https://x/1",
    );
  });

  it("falls back to 'unknown source' when sourceName is empty", () => {
    expect(buildStoryCoverInput({ ...INPUT, sourceName: "" })).toContain("Publisher: unknown source");
  });

  it("maps a clean story-cover output to a GeneratorOutput", async () => {
    const runner = fakeTtsRunner({ routes: { "story-cover": { body: ttsOk(COVER) } } });
    const gen = createTtsStoryGenerator(new TtsClient("http://tts.test", runner));

    const out = await gen.generate(INPUT);

    expect(out).toEqual(COVER);
  });

  it("normalizes a bad category to WORLD rather than failing", async () => {
    const runner = fakeTtsRunner({ routes: { "story-cover": { body: ttsOk({ ...COVER, category: "GOSSIP" }) } } });
    const out = await createTtsStoryGenerator(new TtsClient("http://tts.test", runner)).generate(INPUT);
    expect(out?.category).toBe("WORLD");
  });

  it("returns null when a required field is missing/empty", async () => {
    const runner = fakeTtsRunner({ routes: { "story-cover": { body: ttsOk({ ...COVER, headline: "" }) } } });
    const out = await createTtsStoryGenerator(new TtsClient("http://tts.test", runner)).generate(INPUT);
    expect(out).toBeNull();
  });

  it("returns a NEUTRAL imagePrompt (no style words) that wraps exactly once downstream", async () => {
    const runner = fakeTtsRunner({ routes: { "story-cover": { body: ttsOk(COVER) } } });
    const out = (await createTtsStoryGenerator(new TtsClient("http://tts.test", runner)).generate(INPUT)) as GeneratorOutput;

    // The provider returns the prompt unwrapped — identical in kind to the incumbent's output.
    expect(out.imagePrompt).toBe(COVER.imagePrompt);
    const style = "TEST-STYLE plastic building-block diorama";
    expect(out.imagePrompt).not.toContain(style);
    // Downstream applies wrapBrickStyle once; the style must appear exactly once (no double-wrap).
    const wrapped = wrapBrickStyle(out.imagePrompt, style);
    expect(wrapped.split(style)).toHaveLength(2);
  });
});

describe("TtsFailoverGenerator", () => {
  it("uses the TTS result when present", async () => {
    const tts: Generator = { generate: async () => COVER as GeneratorOutput };
    const incumbent = fakeGenerator({});
    const out = await new TtsFailoverGenerator(tts, incumbent).generate(INPUT);
    expect(out).toEqual(COVER);
    expect(incumbent.calls).toHaveLength(0);
  });

  it("falls back to the incumbent when TTS returns null", async () => {
    const tts: Generator = { generate: async () => null };
    const incumbent = fakeGenerator({});
    const out = await new TtsFailoverGenerator(tts, incumbent).generate(INPUT);
    expect(out?.headline).toBe(`Rewritten: ${INPUT.title}`);
    expect(incumbent.calls).toHaveLength(1);
  });
});

describe("createGenerator story-cover wiring (ADR-0022)", () => {
  it("leaves the incumbent unchanged when generator.tts is absent", () => {
    expect(createGenerator(makeConfig())).toBeInstanceOf(GrokGenerator);
  });

  it("leaves the incumbent unchanged when storyCover is false", () => {
    const c = ttsConfig({ storyCover: false });
    expect(createGenerator(c)).toBeInstanceOf(GrokGenerator);
  });

  it("wraps the incumbent in a failover generator when storyCover is true", async () => {
    const runner = fakeTtsRunner({ routes: { "story-cover": { body: ttsOk(COVER) } } });
    const gen = createGenerator(ttsConfig(), { ttsRunner: runner });
    expect(gen).toBeInstanceOf(TtsFailoverGenerator);
    expect(await gen.generate(INPUT)).toEqual(COVER);
  });

  it("fails over to the incumbent Grok path on a TTS error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fakeTtsRunner({ routes: { "story-cover": { ok: false, status: 500, body: ttsErr("internal") } } });
    let incumbentCalled = false;
    const gen = createGenerator(ttsConfig(), {
      ttsRunner: runner,
      grokRunner: async () => {
        incumbentCalled = true;
        return { ok: false, status: 500, body: "" };
      },
    });
    const out = await gen.generate(INPUT);
    expect(out).toBeNull(); // both failed → pending
    expect(incumbentCalled).toBe(true); // but the incumbent WAS tried
  });
});
