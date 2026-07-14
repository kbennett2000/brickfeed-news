/**
 * Opt-in LIVE test against a real `text-transform-service` (ADR-0022). SKIPPED by default so
 * CI stays hermetic (no network, no GPU). Enable it against a running TTS that serves the
 * Brickfeed transforms:
 *
 *   TTS_LIVE=1 TTS_URL=http://G434:8712 npx vitest run test/tts.live.test.ts
 *
 * It asserts SHAPE and bounds only (never wording), and that the returned image prompt is
 * subject-neutral (no toy-brick style words — those are applied caller-side).
 */
import { describe, expect, it } from "vitest";
import { TtsClient, createTtsStoryGenerator, defaultTtsRunner } from "../src/generator/tts.js";

const LIVE = process.env.TTS_LIVE === "1";
const URL = process.env.TTS_URL ?? "http://G434:8712";

describe.skipIf(!LIVE)("TTS live (opt-in: TTS_LIVE=1)", () => {
  it("story-cover returns a well-shaped, subject-neutral cover bundle", async () => {
    const gen = createTtsStoryGenerator(new TtsClient(URL, defaultTtsRunner));
    const out = await gen.generate({
      title: "Town's giant pumpkin smashes the state record",
      sourceName: "Metro Herald",
      url: "https://example.com/pumpkin",
    });

    expect(out).not.toBeNull();
    if (out == null) return;
    expect(out.headline.length).toBeGreaterThanOrEqual(10);
    expect(out.description.length).toBeGreaterThanOrEqual(40);
    expect(out.imagePrompt.length).toBeGreaterThanOrEqual(30);
    expect(out.caption.length).toBeGreaterThanOrEqual(15);
    expect(["WORLD", "POLITICS", "BUSINESS", "TECHNOLOGY", "SCIENCE", "SPORTS", "CULTURE", "OPINION"]).toContain(
      out.category,
    );
    // Subject-neutral: no medium/style words leak from the transform (ADR-0004).
    expect(out.imagePrompt.toLowerCase()).not.toMatch(/\b(cartoon|photo|plastic|brick|miniature|figurine)\b/);
  });
});
