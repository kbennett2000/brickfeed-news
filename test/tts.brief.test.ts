import { describe, expect, it } from "vitest";
import { wrapBrickStyle } from "../src/brick.js";
import { TtsClient } from "../src/generator/tts.js";
import type { GateVerdict } from "../src/opinions.js";
import { runOpinions } from "../src/opinions.js";
import {
  buildBriefInput,
  createOpinionTtsDeps,
  mapBriefOutput,
  ttsImageBrief,
} from "../src/opinions-tts.js";
import type { OpinionAssets, Persona } from "../src/personas.js";
import type { Manifest, ManifestRecord } from "../src/types.js";
import {
  fakeTextGenerator,
  fixedNow,
  lettersPersona,
  makeConfig,
  newsPersona,
  ttsErr,
  ttsOk,
} from "./helpers.js";

const NOW = "2026-07-12T15:00:00.000Z"; // Sunday
const CONFIG = makeConfig();
const BRIEF = { imagePrompt: "A stack of comically tall pancakes wobbles on a diner counter", caption: "A wobbling tower of pancakes on a diner counter" };

const isBriefCall = (p: string): boolean => p.includes("image brief");
const isGateCall = (p: string): boolean => p.includes("STORIES:");

function story(id: string): ManifestRecord {
  return {
    id,
    url: `https://x/${id}`,
    title: `Story ${id}`,
    sourceName: "Wire",
    firstSeen: "2026-07-12T10:00:00.000Z",
    lastSeen: NOW,
    headline: `Headline ${id}`,
    description: `Description ${id}.`,
    imagePrompt: "a scene",
    wrappedPrompt: "STYLE a scene",
    category: "WORLD",
    caption: "a caption",
    imageUrl: `https://cdn.test/${id}.webp`,
    imageStoredAt: NOW,
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

function sundayAssets(): OpinionAssets {
  return {
    personas: [
      newsPersona("alice"),
      newsPersona("bob"),
      lettersPersona("priscilla", ["tue", "thu", "sat", "sun"]),
      lettersPersona("tom", ["mon", "wed", "fri", "sun"]),
    ] as Persona[],
    shared: "SHARED RULES",
    letters: "LETTER RULES",
    comments: "COMMENT RULES",
    evergreen: "EVERGREEN RULES",
  };
}

const piece = (n: number): string => `A Piece Title\n\n${"word ".repeat(n).trim()}`;
/** Letter personas (priscilla, tom) must reproduce the reader's letter first (ADR-0031). */
const pieceFor = (prompt: string, n: number): string => {
  const letter = (name: string): string =>
    `A Piece Title\n\nDear ${name},\n\nWhy is my wifi slow?\n\n— Jamie, Erie, Pennsylvania\n\n` +
    `${"word ".repeat(n).trim()}`;
  if (prompt.includes("You are priscilla")) return letter("Priscilla");
  if (prompt.includes("You are tom")) return letter("Tom");
  return piece(n);
};
const briefJson = (): string => JSON.stringify({ imagePrompt: "incumbent scene", caption: "incumbent caption" });

describe("opinion-image-brief TTS adapter", () => {
  it("builds an input with the finished piece and news subject articles", () => {
    const input = buildBriefInput(newsPersona("alice"), "T", "the body", [story("s1")]);
    expect(input).toContain("Title: T");
    expect(input).toContain("the body");
    expect(input).toContain("SOURCE ARTICLES the piece reacts to:");
    expect(input).toContain("Headline s1");
  });

  it("builds a subject phrase (not articles) for letters personas", () => {
    const input = buildBriefInput(lettersPersona("tom", ["sun"]), "T", "body", []);
    expect(input).toContain("SUBJECT: the everyday situation");
    expect(input).not.toContain("SOURCE ARTICLES");
  });

  it("maps a clean output to an ImageBrief; null when a key is missing", () => {
    expect(mapBriefOutput(BRIEF)).toEqual(BRIEF);
    expect(mapBriefOutput({ imagePrompt: "x only" })).toBeNull();
    expect(mapBriefOutput({ imagePrompt: " ", caption: "c" })).toBeNull();
  });

  it("returns the brief on a clean 200", async () => {
    const runner = () => Promise.resolve({ ok: true, status: 200, body: ttsOk(BRIEF) });
    const out = await ttsImageBrief(new TtsClient("http://tts.test", runner), newsPersona("a"), "T", "b", []);
    expect(out).toEqual(BRIEF);
  });

  it("returns null on any TTS error (so the caller fails over)", async () => {
    const runner = () => Promise.resolve({ ok: false, status: 500, body: ttsErr("internal") });
    const out = await ttsImageBrief(new TtsClient("http://tts.test", runner), newsPersona("a"), "T", "b", []);
    expect(out).toBeNull();
  });
});

describe("createOpinionTtsDeps — config gating", () => {
  it("returns {} when the tts block is absent", () => {
    expect(createOpinionTtsDeps(makeConfig())).toEqual({});
  });

  it("returns {} when neither opinion task is opted in (e.g. only storyCover)", () => {
    const c = makeConfig();
    c.generator.tts = { url: "http://tts.test", storyCover: true, opinionGate: false, opinionImageBrief: false };
    expect(createOpinionTtsDeps(c)).toEqual({});
  });

  it("builds only the flagged task functions", () => {
    const c = makeConfig();
    c.generator.tts = { url: "http://tts.test", storyCover: false, opinionGate: true, opinionImageBrief: false };
    const deps = createOpinionTtsDeps(c);
    expect(typeof deps.ttsGate).toBe("function");
    expect(deps.ttsBrief).toBeUndefined();
  });
});

describe("runOpinions — TTS brief failover (ADR-0022)", () => {
  it("uses the TTS brief when it succeeds; the incumbent brief call is NOT made", async () => {
    const generate = fakeTextGenerator({
      impl: (p) => (isBriefCall(p) ? briefJson() : pieceFor(p, 1600)),
    });
    const result = await runOpinions(
      CONFIG,
      manifestOf(),
      sundayAssets(),
      { generate, now: fixedNow(NOW), ttsBrief: async () => BRIEF },
      { authors: ["priscilla"] },
    );

    const rec = result.manifest.stories["opinion-priscilla-2026-07-12"];
    expect(rec.imagePrompt).toBe(BRIEF.imagePrompt); // from TTS, NEUTRAL
    expect(rec.caption).toBe(BRIEF.caption);
    // Wrapped exactly once downstream (no double-wrap), same chokepoint as the incumbent.
    expect(rec.wrappedPrompt).toBe(wrapBrickStyle(BRIEF.imagePrompt, CONFIG.brickStyle.styleLanguage));
    expect(generate.calls.filter(isBriefCall)).toHaveLength(0); // TTS handled it
    expect(generate.calls.some((p) => !isBriefCall(p))).toBe(true); // piece still on incumbent
  });

  it("fails over to the incumbent brief call when the TTS brief returns null", async () => {
    const generate = fakeTextGenerator({
      impl: (p) => (isBriefCall(p) ? briefJson() : pieceFor(p, 1600)),
    });
    const result = await runOpinions(
      CONFIG,
      manifestOf(),
      sundayAssets(),
      { generate, now: fixedNow(NOW), ttsBrief: async () => null },
      { authors: ["priscilla"] },
    );

    const rec = result.manifest.stories["opinion-priscilla-2026-07-12"];
    expect(rec.imagePrompt).toBe("incumbent scene"); // from the incumbent fallback
    expect(generate.calls.filter(isBriefCall)).toHaveLength(1);
  });
});

describe("runOpinions — TTS gate failover integration (owner directive 2026-07-14)", () => {
  const gateJson = (ids: string[]): string =>
    JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "eligible", reason: "ok" })) });

  it("ttsGate null FAILS OVER to the Claude gate (news authors still publish); letters unaffected", async () => {
    // TTS gate down → the incumbent Claude gate runs instead of fail-closed, so news satire
    // isn't silently starved. The underlying TTS failure is reported separately (client observer).
    const generate = fakeTextGenerator({
      impl: (p) => {
        if (isGateCall(p)) return gateJson(["s1", "s2"]); // Claude failover: both eligible
        if (isBriefCall(p)) return briefJson();
        return pieceFor(p, 1600);
      },
    });
    const result = await runOpinions(
      CONFIG,
      manifestOf(story("s1"), story("s2")),
      sundayAssets(),
      { generate, now: fixedNow(NOW), ttsGate: async () => null },
    );

    const byName = new Map(result.authors.map((a) => [a.author, a.status]));
    expect(byName.get("alice")).toBe("published");
    expect(byName.get("bob")).toBe("published");
    expect(byName.get("priscilla")).toBe("published");
    expect(byName.get("tom")).toBe("published");
    // The incumbent Claude gate IS used on failover — exactly once (one batched classification).
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(result.gateSummary).toContain("via Claude (TTS failover)");
  });

  it("ttsGate verdicts drive selection when it succeeds (no Claude gate call)", async () => {
    const generate = fakeTextGenerator({ impl: (p) => (isBriefCall(p) ? briefJson() : pieceFor(p, 1600)) });
    const gate = async (candidates: ManifestRecord[]) => {
      const m = new Map<string, GateVerdict>();
      for (const r of candidates) m.set(r.id, { id: r.id, verdict: "eligible", reason: "ok" });
      return m;
    };
    const result = await runOpinions(
      CONFIG,
      manifestOf(story("s1"), story("s2")),
      sundayAssets(),
      { generate, now: fixedNow(NOW), ttsGate: gate },
    );

    expect(result.gateSummary).toBe("gate passed 2/2 candidate(s) via TTS");
    expect(result.authors.find((a) => a.author === "alice")?.status).toBe("published");
    expect(generate.calls.filter(isGateCall)).toHaveLength(0); // TTS succeeded → no failover
  });
});
