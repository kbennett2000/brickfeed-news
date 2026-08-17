import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wrapBrickStyle } from "../src/brick.js";
import {
  CANDIDATE_WINDOW_HOURS,
  DEFAULT_LENGTH_RANGE,
  LENGTH_RANGES,
  MAX_PIECE_ATTEMPTS,
  OPINION_STALE_THRESHOLD_HOURS,
  ROTATION,
  authorsFor,
  beforeOpinionPublishHour,
  buildGatePrompt,
  buildImageBriefPrompt,
  buildOpinionPrompt,
  daysSinceUnixEpoch,
  opinionCandidates,
  opinionKey,
  opinionsStageOutcome,
  opinionStaleness,
  parseGateVerdicts,
  parseImageBrief,
  runOpinions,
  splitTitleBody,
  summarizeOpinions,
  utcDateOf,
  weekdayOf,
  weightedSample,
} from "../src/opinions.js";
import type { OpinionAssets, Persona } from "../src/personas.js";
import type { Manifest, ManifestRecord } from "../src/types.js";
import { fakeTextGenerator, fixedNow, lettersPersona, makeConfig, newsPersona } from "./helpers.js";

/** 2026-07-12 is a Sunday: rotation index 20646 % 3 = 0 → alice+bob, plus both letters. */
const NOW = "2026-07-12T15:00:00.000Z";
const TODAY = "2026-07-12";

const CONFIG = makeConfig();

/** A publishable non-OPINION story, fresh inside the 24h candidate window. */
function story(id: string, over: Partial<ManifestRecord> = {}): ManifestRecord {
  return {
    id,
    url: `https://example.com/${id}`,
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
    ...over,
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

/** The full nine-persona roster (rotation members + the daily fixture + both letters columnists). */
function fullRoster(): Persona[] {
  return [
    newsPersona("alice"),
    newsPersona("bob"),
    newsPersona("cynthia"),
    newsPersona("edgar"),
    newsPersona("larry"),
    newsPersona("stryker"),
    newsPersona("hodge"), // ADR-0027 daily fixture — publishes every day, outside ROTATION
    lettersPersona("priscilla", ["tue", "thu", "sat", "sun"]),
    lettersPersona("tom", ["mon", "wed", "fri", "sun"]),
  ];
}

function assetsOf(...personas: Persona[]): OpinionAssets {
  return { personas, shared: "SHARED RULES", letters: "LETTER RULES", comments: "COMMENT RULES", evergreen: "EVERGREEN RULES" };
}

/** The four Sunday authors: rotation pair alice+bob + both letters personas. */
function sundayAssets(): OpinionAssets {
  return assetsOf(
    newsPersona("alice", { POLITICS: 3, WORLD: 1 }),
    newsPersona("bob"),
    lettersPersona("priscilla", ["tue", "thu", "sat", "sun"]),
    lettersPersona("tom", ["mon", "wed", "fri", "sun"]),
  );
}

/** A strict gate response covering `ids`, marking `excluded` ids excluded. */
function verdictsJson(ids: string[], excluded: string[] = []): string {
  return JSON.stringify({
    verdicts: ids.map((id) => ({
      id,
      verdict: excluded.includes(id) ? "excluded" : "eligible",
      reason: "test reason",
    })),
  });
}

/** A valid title+body completion with an n-word body. */
function piece(n: number): string {
  return `A Piece Title\n\n${"word ".repeat(n).trim()}`;
}

/**
 * A completion shaped for the persona the prompt targets. Letter personas (priscilla, tom) must
 * reproduce the reader's letter first (ADR-0031, letterColumnHasLetter), so their bodies open with
 * a "Dear <Name>," letter before the n filler words; every other persona gets a plain piece.
 */
function pieceFor(prompt: string, n: number): string {
  const letter = (name: string): string =>
    `A Piece Title\n\nDear ${name},\n\nI have a question about my situation. What should I do?\n\n` +
    `— Jamie, Erie, Pennsylvania\n\n${"word ".repeat(n).trim()}`;
  if (prompt.includes("You are priscilla")) return letter("Priscilla");
  if (prompt.includes("You are tom")) return letter("Tom");
  return piece(n);
}

const isGateCall = (prompt: string): boolean => prompt.includes("STORIES:");
const isBriefCall = (prompt: string): boolean => prompt.includes("image brief");

/** A valid image-brief completion (ADR-0016). */
function briefJson(): string {
  return JSON.stringify({ imagePrompt: "a tiny park scene", caption: "A wry caption line" });
}

/** A deterministic rng cycling through `values`. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("date helpers", () => {
  it("daysSinceUnixEpoch floors whole UTC days", () => {
    expect(daysSinceUnixEpoch(new Date("2026-07-12T00:00:00Z"))).toBe(20646);
    expect(daysSinceUnixEpoch(new Date("2026-07-12T23:59:59Z"))).toBe(20646);
    expect(daysSinceUnixEpoch(new Date("2026-07-13T00:00:00Z"))).toBe(20647);
  });

  it("weekdayOf maps UTC weekdays onto the mon-first WEEKDAYS tokens", () => {
    expect(weekdayOf(new Date("2026-07-12T12:00:00Z"))).toBe("sun");
    expect(weekdayOf(new Date("2026-07-13T12:00:00Z"))).toBe("mon");
    expect(weekdayOf(new Date("2026-07-18T12:00:00Z"))).toBe("sat");
  });

  it("utcDateOf and opinionKey produce the UTC-day idempotency key", () => {
    expect(utcDateOf(new Date(NOW))).toBe(TODAY);
    expect(opinionKey("alice", TODAY)).toBe("opinion-alice-2026-07-12");
  });
});

describe("authorsFor — rotation pair + letters schedule overlay (pure)", () => {
  const names = (date: string, personas = fullRoster()) =>
    authorsFor(date, personas).map((p) => p.name);

  it("Sunday yields the pair, the daily fixture, plus BOTH letters personas (the intentional double)", () => {
    expect(names("2026-07-12")).toEqual(["alice", "bob", "hodge", "priscilla", "tom"]);
  });

  it("walks the 3-day rotation with the daily fixture and the scheduled letters overlay", () => {
    expect(names("2026-07-13")).toEqual(["edgar", "stryker", "hodge", "tom"]); // Mon
    expect(names("2026-07-14")).toEqual(["larry", "cynthia", "hodge", "priscilla"]); // Tue
    expect(names("2026-07-15")).toEqual(["alice", "bob", "hodge", "tom"]); // Wed — wrapped
  });

  it("ADR-0027: the daily fixture (hodge) publishes every day, across the whole rotation", () => {
    // Four consecutive days span the 3-pair cycle and wrap; hodge appears on all of them.
    for (const day of ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15"]) {
      expect(names(day)).toContain("hodge");
    }
  });

  it("a rotation member missing from the roster is simply absent", () => {
    const noBob = fullRoster().filter((p) => p.name !== "bob");
    expect(names("2026-07-12", noBob)).toEqual(["alice", "hodge", "priscilla", "tom"]);
  });

  it("is pure: repeat calls agree, and ROTATION pins the ADR-0013 pair order", () => {
    expect(names("2026-07-12")).toEqual(names("2026-07-12"));
    expect(ROTATION).toEqual([
      ["alice", "bob"],
      ["edgar", "stryker"],
      ["larry", "cynthia"],
    ]);
  });
});

describe("opinionCandidates — the 24h publishable non-opinion pool", () => {
  it("includes only publishable, non-OPINION, non-author records inside the window", () => {
    const nowMs = new Date(NOW).getTime();
    const manifest = manifestOf(
      story("fresh"),
      story("newer", { firstSeen: "2026-07-12T14:00:00.000Z" }),
      story("stale", { firstSeen: "2026-07-11T14:00:00.000Z" }), // 25h old
      story("pending", { imageUrl: undefined }), // not publishable
      story("opinion-cat", { category: "OPINION" }),
      story("authored", { author: "alice" }),
      story("bad-ts", { firstSeen: "not-a-date" }),
    );

    const ids = opinionCandidates(manifest, nowMs).map((r) => r.id);
    expect(ids).toEqual(["newer", "fresh"]); // newest-first
    expect(CANDIDATE_WINDOW_HOURS).toBe(24);
  });
});

describe("parseGateVerdicts — strict, fail-closed", () => {
  const ids = ["a", "b"];

  it("accepts strict JSON, fenced JSON, and prose-wrapped JSON", () => {
    const json = verdictsJson(ids, ["b"]);
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Sure! Here you go:\n${json}\nDone.`]) {
      const map = parseGateVerdicts(text, ids);
      expect(map).not.toBeNull();
      expect(map?.get("a")?.verdict).toBe("eligible");
      expect(map?.get("b")?.verdict).toBe("excluded");
      expect(map?.get("b")?.reason).toBe("test reason");
    }
  });

  it("tolerates a missing reason (empty string), nothing else", () => {
    const map = parseGateVerdicts(
      JSON.stringify({ verdicts: [{ id: "a", verdict: "eligible" }] }),
      ["a"],
    );
    expect(map?.get("a")?.reason).toBe("");
  });

  it.each([
    ["not JSON at all", "no verdicts here"],
    ["missing an id", verdictsJson(["a"])],
    ["unknown id", verdictsJson(["a", "b", "c"])],
    ["duplicate id", JSON.stringify({ verdicts: [
      { id: "a", verdict: "eligible", reason: "" },
      { id: "a", verdict: "eligible", reason: "" },
      { id: "b", verdict: "eligible", reason: "" },
    ] })],
    ["bad verdict token", JSON.stringify({ verdicts: [
      { id: "a", verdict: "ELIGIBLE", reason: "" },
      { id: "b", verdict: "eligible", reason: "" },
    ] })],
    ["verdicts not an array", JSON.stringify({ verdicts: "yes" })],
    ["array not object", JSON.stringify([{ id: "a" }])],
  ])("rejects %s → null (all excluded)", (_label, text) => {
    expect(parseGateVerdicts(text, ids)).toBeNull();
  });
});

describe("weightedSample — bias-weighted, floor for unlisted, no replacement", () => {
  const c = (id: string, category: ManifestRecord["category"]) => story(id, { category });

  it("respects bias weights deterministically with an injected rng", () => {
    const candidates = [c("p", "POLITICS"), c("w", "WORLD"), c("u", "CULTURE")];
    const bias = { POLITICS: 3, WORLD: 1 }; // u → floor 0.25; total 4.25
    // roll 0 → lands in p's [0,3); then remaining total 1.25, roll 0.9*1.25=1.125 → u.
    const picked = weightedSample(candidates, bias, 2, seq(0, 0.9));
    expect(picked.map((r) => r.id)).toEqual(["p", "u"]);
  });

  it("an unlisted NON-owned section is rare but reachable (floor weight, never zero)", () => {
    const candidates = [c("p", "POLITICS"), c("u", "CULTURE")];
    // total 3.25; roll 0.99*3.25 = 3.2175 > 3 → the floor-weighted CULTURE story.
    const picked = weightedSample(candidates, { POLITICS: 3 }, 1, seq(0.99));
    expect(picked.map((r) => r.id)).toEqual(["u"]);
  });

  it("an OWNED section (SPORTS) is never drawn by a persona that doesn't list it", () => {
    const candidates = [c("p", "POLITICS"), c("s", "SPORTS")];
    // SPORTS is weight 0 for a non-owner even at the FP-edge roll → only POLITICS is drawable.
    const picked = weightedSample(candidates, { POLITICS: 3 }, 2, seq(0.99, 0.99));
    expect(picked.map((r) => r.id)).toEqual(["p"]);
  });

  it("an OWNED section IS drawn by the persona that explicitly lists it", () => {
    const candidates = [c("s1", "SPORTS"), c("s2", "SPORTS")];
    const picked = weightedSample(candidates, { SPORTS: 1 }, 2, seq(0.1, 0.9));
    expect(new Set(picked.map((r) => r.id)).size).toBe(2);
  });

  it("exclusive: only explicitly-listed sections are eligible (Hodge = SPORTS-only)", () => {
    const candidates = [c("s", "SPORTS"), c("p", "POLITICS"), c("u", "CULTURE")];
    // With exclusive=true, POLITICS/CULTURE are hard-excluded even though CULTURE would
    // normally floor-weight in; only the listed SPORTS story is drawable.
    const picked = weightedSample(candidates, { SPORTS: 1 }, 3, seq(0.5, 0.5, 0.5), true);
    expect(picked.map((r) => r.id)).toEqual(["s"]);
  });

  it("returns empty when nothing is positively weighted (→ caller's evergreen fallback)", () => {
    // A SPORTS-only exclusive persona with no SPORTS candidate draws nothing.
    const candidates = [c("p", "POLITICS"), c("w", "WORLD")];
    const picked = weightedSample(candidates, { SPORTS: 1 }, 3, seq(0.5), true);
    expect(picked).toEqual([]);
  });

  it("samples without replacement and caps at the pool size", () => {
    const candidates = [c("a", "WORLD"), c("b", "WORLD"), c("c", "WORLD")];
    const picked = weightedSample(candidates, {}, 5, seq(0.5));
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((r) => r.id)).size).toBe(3);
  });
});

describe("prompt assembly + output contract", () => {
  it("news prompt = shared + voice + articles + ranged title task (no letters block)", () => {
    const assets = sundayAssets();
    const alice = assets.personas[0];
    const prompt = buildOpinionPrompt(assets, alice, [story("s1"), story("s2")]);

    expect(prompt).toContain("SHARED RULES");
    expect(prompt).toContain(alice.body);
    expect(prompt).toContain("ARTICLE 1:\nHeadline s1");
    expect(prompt).toContain("(via Wire: Story s1)");
    expect(prompt).toContain("ARTICLE 2:");
    expect(prompt).toContain("1400-2000 word opinion piece");
    expect(prompt).toContain("First line: a short original title");
    expect(prompt).not.toContain("LETTER RULES");
  });

  it("letters prompt = shared + letters rules + voice + title task (no articles)", () => {
    const assets = sundayAssets();
    const tom = assets.personas.find((p) => p.name === "tom") as Persona;
    const prompt = buildOpinionPrompt(assets, tom, []);

    expect(prompt).toContain("SHARED RULES");
    expect(prompt).toContain("LETTER RULES");
    expect(prompt).toContain(tom.body);
    expect(prompt).toContain("1200-1600 word reader-letter column"); // Tom tracks the default now
    expect(prompt).toContain("invent the letter per your instructions above");
    expect(prompt).toContain("First line: a short original title");
    expect(prompt).not.toContain("ARTICLE");
  });

  it("news prompt with NO articles = shared + evergreen block + voice (ADR-0032 D)", () => {
    const assets = sundayAssets();
    const alice = assets.personas[0];
    const prompt = buildOpinionPrompt(assets, alice, []);

    expect(prompt).toContain("SHARED RULES");
    expect(prompt).toContain("EVERGREEN RULES");
    expect(prompt).toContain(alice.body);
    expect(prompt).toContain("evergreen column per the instructions above");
    expect(prompt).toContain("no source story today");
    expect(prompt).not.toContain("ARTICLE");
    expect(prompt).not.toContain("LETTER RULES");
  });

  it("evergreen image brief carries no article block and an ordinary-subject line", () => {
    const assets = sundayAssets();
    const alice = assets.personas[0];
    const brief = buildImageBriefPrompt(alice, "A Title", "A body about a stapler.", []);
    expect(brief).toContain("the ordinary, everyday subject the piece is about");
    expect(brief).not.toContain("SOURCE ARTICLES");
  });

  it("the gate prompt batches every candidate id with our rewritten text", () => {
    const prompt = buildGatePrompt([story("s1"), story("s2")]);
    expect(prompt).toContain('"id": "s1"');
    expect(prompt).toContain('"id": "s2"');
    expect(prompt).toContain("Headline s1");
    expect(prompt).toContain("If uncertain, exclude");
    expect(prompt).toContain("STRICT JSON");
  });

  it("splitTitleBody: title line + body, markdown heading stripped, half pieces rejected", () => {
    expect(splitTitleBody("The Title\n\nThe body text.")).toEqual({
      title: "The Title",
      body: "The body text.",
    });
    expect(splitTitleBody("# The Title\nThe body.")).toEqual({
      title: "The Title",
      body: "The body.",
    });
    // Models like to dress the title line up — wrapping bold/quotes are stripped …
    expect(splitTitleBody("**The Casserole Reckoning**\n\nBody.")?.title).toBe(
      "The Casserole Reckoning",
    );
    expect(splitTitleBody('"Quoted Title"\n\nBody.')?.title).toBe("Quoted Title");
    // … but interior markup and unbalanced wrappers are left alone.
    expect(splitTitleBody("Stars * Among * Us\n\nBody.")?.title).toBe("Stars * Among * Us");
    expect(splitTitleBody('"Unbalanced opener\n\nBody.')?.title).toBe('"Unbalanced opener');
    expect(splitTitleBody("just one line, no body")).toBeNull();
    expect(splitTitleBody("Title\n\n   ")).toBeNull();
    expect(splitTitleBody("")).toBeNull();
  });

  it("splitTitleBody: recovers the real title when the model leaks junk before it", () => {
    // The exact Priscilla "Wisdom's Moat" leak: preamble sentence, then a bare
    // delimiter, then the real bold title — the real title must win.
    const leak =
      "I see the task: write one reader-letter column as Priscilla — advice in her " +
      "measured voice.\n\n---\n\n**Wisdom's Moat**\n\n" +
      "Dear Priscilla, my neighbor keeps borrowing my ladder. Signed, Fed Up.";
    const split = splitTitleBody(leak);
    expect(split?.title).toBe("Wisdom's Moat");
    expect(split?.body).toMatch(/^Dear Priscilla/);

    // Bare delimiter first.
    expect(splitTitleBody("---\n\n**Real Title**\n\nBody.")?.title).toBe("Real Title");
    // Label lines.
    expect(splitTitleBody("Title: The Real Title\n\nBody.")?.title).toBe("The Real Title");
    expect(splitTitleBody("Headline: X\n\nBody.")?.title).toBe("X");
    // Opener preamble then real title.
    expect(splitTitleBody("Here is your column:\n\nThe Real Title\n\nBody.")?.title).toBe(
      "The Real Title",
    );
    // Whole-completion code fence unwrapped.
    expect(splitTitleBody("```\nThe Title\n\nBody.\n```")?.title).toBe("The Title");
  });

  it("splitTitleBody: recovers past a short colon-less meta sentence (the 2026-08-01 leak)", () => {
    // The exact leak that shipped: "I'll write ... now." — no colon, short enough to have passed
    // the title bounds, but a full meta-narration sentence. It must NOT become the title; the
    // real invented column title is recovered.
    const leak =
      "I'll write one reader-letter column for Priscilla now.\n\n---\n\n" +
      "**The Dinner Party Question**\n\nDear Priscilla, my partner wants me to attend a dinner party.";
    const split = splitTitleBody(leak);
    expect(split?.title).toBe("The Dinner Party Question");
    expect(split?.title).not.toMatch(/I'll write/);
    expect(split?.body).toMatch(/^Dear Priscilla/);
  });

  it("splitTitleBody: fails closed when the only title-position line is a meta sentence", () => {
    // No recoverable real title after the preamble ⇒ drop the piece rather than publish the leak.
    expect(splitTitleBody("I'll write the column now.\n\nSome body text here.")).toBeNull();
  });

  it("splitTitleBody: fails closed on refusals and paragraph-as-title, keeps legit titles", () => {
    // Refusals never publish.
    expect(splitTitleBody("I can't help with that request.\n\nSomething else.")).toBeNull();
    expect(splitTitleBody("I'm sorry, but I cannot write that.\n\nMore.")).toBeNull();
    // A paragraph masquerading as a title (no recoverable real title) is rejected.
    const paragraph = `${"word ".repeat(40).trim()}\n\nBody.`;
    expect(splitTitleBody(paragraph)).toBeNull();
    // Conservatism: legit short titles that open with a stop word are preserved.
    expect(splitTitleBody("Okay Boomer\n\nBody paragraph here.")?.title).toBe("Okay Boomer");
    expect(splitTitleBody("Sure Thing\n\nBody paragraph here.")?.title).toBe("Sure Thing");
    // "I Can't Even" is a title, not a refusal (no refusal object follows).
    expect(splitTitleBody("I Can't Even\n\nBody paragraph here.")?.title).toBe("I Can't Even");
  });

  it("splitTitleBody: letter-gated attribution title fails closed only for letter columns", () => {
    // The 2026-08-16 Priscilla leak: the invented letter-writer's attribution used as the title.
    const leak = "Wanda from Flagstaff, Arizona\n\nA lovely question, Wanda. Order the lobster.";
    // Letter column ⇒ rejected so the author re-rolls a proper title this cycle.
    expect(splitTitleBody(leak, true)).toBeNull();
    // News column (default) ⇒ the gate is off; an unrelated title is unaffected.
    expect(splitTitleBody("On the State of Things\n\nBody paragraph here.", true)?.title).toBe(
      "On the State of Things",
    );
    // A real letter-column title is kept even with the gate on.
    expect(splitTitleBody("Do Not Split the Nachos\n\nOrder the lobster.", true)?.title).toBe(
      "Do Not Split the Nachos",
    );
  });

  it("length ranges pin the persona prose (drift guard on the committed assets)", () => {
    expect(DEFAULT_LENGTH_RANGE).toEqual([1200, 1600]);
    expect(LENGTH_RANGES).toEqual({ edgar: [1600, 2500], alice: [1400, 2000] });
    // The constants mirror the spec-of-record in the persona PROSE — if a human edits
    // the .md ranges, this fails loud instead of silently mis-validating.
    expect(readFileSync("personas/_shared.md", "utf8")).toMatch(/1200–1600 words/);
    expect(readFileSync("personas/alice.md", "utf8")).toMatch(/1400–2000 words/);
    expect(readFileSync("personas/edgar.md", "utf8")).toMatch(/1600–2500 words/);
  });
});

describe("runOpinions — publish path", () => {
  function happyGenerate() {
    return fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s2", "s1", "s3"]);
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
  }

  it("Sunday launch: four authors publish; one gate call; records carry the contract fields", async () => {
    const generate = happyGenerate();
    const starting = manifestOf(story("s1"), story("s2"), story("s3"));
    const result = await runOpinions(CONFIG,starting, sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });

    expect(result.ok).toBe(true);
    expect(result.date).toBe(TODAY);
    expect(result.authors.map((a) => [a.author, a.status])).toEqual([
      ["alice", "published"],
      ["bob", "published"],
      ["priscilla", "published"],
      ["tom", "published"],
    ]);
    expect(summarizeOpinions(result)).toBe(
      "4 published, 0 skipped, 0 failed; gate passed 3/3 candidate(s) via Claude",
    );
    // Exactly ONE gate classification for the whole 4-author run.
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(generate.calls.filter(isBriefCall)).toHaveLength(4); // one brief per piece
    expect(generate.calls).toHaveLength(9); // gate + 4 pieces + 4 briefs
    expect(result.gate).toHaveLength(3);

    // The input manifest was never mutated; the returned copy gained exactly 4 records.
    expect(Object.keys(starting.stories)).toHaveLength(3);
    expect(Object.keys(result.manifest.stories)).toHaveLength(7);

    const alice = result.manifest.stories["opinion-alice-2026-07-12"];
    expect(alice).toMatchObject({
      id: "opinion-alice-2026-07-12",
      url: "",
      sourceName: "",
      title: "A Piece Title",
      headline: "A Piece Title",
      category: "OPINION",
      author: "alice",
      firstSeen: NOW,
      lastSeen: NOW,
    });
    expect(alice.description).toContain("word");
    expect(alice.sourceArticleIds?.length).toBeGreaterThanOrEqual(2);
    expect(alice.sourceArticleIds?.every((id) => ["s1", "s2", "s3"].includes(id))).toBe(true);
    expect(alice.columnTitle).toBeUndefined();
    expect(alice.imageUrl).toBeUndefined();
    // The image brief (ADR-0016): neutral prompt + wrap + caption, stored with the piece.
    expect(alice.imagePrompt).toBe("a tiny park scene");
    expect(alice.wrappedPrompt).toBe(
      wrapBrickStyle("a tiny park scene", CONFIG.brickStyle.styleLanguage),
    );
    expect(alice.caption).toBe("A wry caption line");

    const tom = result.manifest.stories["opinion-tom-2026-07-12"];
    expect(tom.columnTitle).toBe("tom's Column");
    expect(tom.sourceArticleIds).toBeUndefined();
  });

  it("gate-excluded stories never appear in sourceArticleIds", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s2", "s1", "s3"], ["s2"]);
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG,
      manifestOf(story("s1"), story("s2"), story("s3")),
      sundayAssets(),
      { generate, now: fixedNow(NOW) },
    );

    for (const name of ["alice", "bob"]) {
      const rec = result.manifest.stories[`opinion-${name}-2026-07-12`];
      expect(rec.sourceArticleIds).not.toContain("s2");
      expect(rec.sourceArticleIds?.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("--authors override runs exactly those personas; unknown names throw", async () => {
    const generate = happyGenerate();
    const result = await runOpinions(CONFIG,manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["tom"] });

    expect(result.authors).toHaveLength(1);
    expect(result.authors[0]).toMatchObject({ author: "tom", status: "published" });
    expect(generate.calls.filter(isGateCall)).toHaveLength(0); // no news author → no gate

    await expect(
      runOpinions(CONFIG, manifestOf(), sundayAssets(), { generate, now: fixedNow(NOW) }, {
        authors: ["nobody"],
      }),
    ).rejects.toThrow('unknown persona "nobody"');
  });

  it("gate passes, but a sports-only persona with no sports story goes evergreen (E+D)", async () => {
    // The pool holds only WORLD stories. alice (WORLD reactor) publishes news-anchored;
    // hodge (SPORTS-only, exclusive) has no eligible pick → evergreen, in the same run.
    const alice = newsPersona("alice", { WORLD: 2 });
    const hodge: Persona = {
      ...newsPersona("hodge", { SPORTS: 1 }),
      sectionsExclusive: true,
    };
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]); // s1 (WORLD) eligible
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), assetsOf(alice, hodge), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["alice", "hodge"] });

    const a = result.authors.find((x) => x.author === "alice");
    const h = result.authors.find((x) => x.author === "hodge");
    expect(a?.status).toBe("published");
    expect(a?.evergreen).toBeUndefined();
    expect(a?.sourceArticleIds).toEqual(["s1"]);
    expect(h?.status).toBe("published");
    expect(h?.evergreen).toBe(true);
    expect(h?.sourceArticleIds).toBeUndefined();
    expect(generate.calls.filter(isGateCall)).toHaveLength(1); // gate still ran for alice
  });

  it("recovers a leaked preamble title end-to-end (record carries the real title)", async () => {
    const leaked =
      `Here is your column:\n\n**The Real Title**\n\nDear Tom,\n\nWhy is my wifi slow at night?\n\n` +
      `— Jamie, Erie, Pennsylvania\n\n${"word ".repeat(1600).trim()}`;
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return briefJson();
        return leaked;
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["tom"] });

    expect(result.authors[0]).toMatchObject({ author: "tom", status: "published" });
    expect(result.manifest.stories["opinion-tom-2026-07-12"].title).toBe("The Real Title");
  });

  it("a refusal completion fails that author closed — never published", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isBriefCall(prompt)) return briefJson();
        return "I can't help with that request.";
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["tom"] });

    expect(result.authors[0]).toMatchObject({
      author: "tom",
      status: "failed",
      detail: "output missing title line or body",
    });
    expect(result.manifest.stories["opinion-tom-2026-07-12"]).toBeUndefined();
  });
});

describe("runOpinions — idempotency", () => {
  it("an existing key skips that author before any piece call", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const seeded = story("opinion-alice-2026-07-12", { category: "OPINION", author: "alice" });
    const result = await runOpinions(CONFIG,manifestOf(story("s1"), seeded), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });

    expect(result.authors.find((a) => a.author === "alice")?.status).toBe("skipped-idempotent");
    expect(result.authors.filter((a) => a.status === "published")).toHaveLength(3);
    // Gate still ran once for bob; no piece prompt ever contained alice's voice.
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(generate.calls.some((p) => p.includes("You are alice"))).toBe(false);
  });

  it("a rerun with every author already published makes ZERO provider calls (gate included)", async () => {
    const generate = fakeTextGenerator();
    const seeded = ["alice", "bob", "priscilla", "tom"].map((name) =>
      story(`opinion-${name}-2026-07-12`, { category: "OPINION", author: name }),
    );
    const result = await runOpinions(CONFIG,
      manifestOf(story("s1"), ...seeded),
      sundayAssets(),
      { generate, now: fixedNow(NOW) },
    );

    expect(generate.calls).toHaveLength(0);
    expect(result.authors.every((a) => a.status === "skipped-idempotent")).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("runOpinions — gate fails closed → news personas fall back to evergreen (ADR-0032 D)", () => {
  it("a malformed gate response yields no news-anchored pieces, but news publish evergreen", async () => {
    const logs: string[] = [];
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return "sorry, I cannot do JSON today";
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG,
      manifestOf(story("s1"), story("s2")),
      sundayAssets(),
      { generate, now: fixedNow(NOW), log: (m) => logs.push(m) },
    );

    // Every scheduled author publishes; the two news reactors as evergreen (no source story).
    expect(result.authors.map((a) => [a.author, a.status])).toEqual([
      ["alice", "published"],
      ["bob", "published"],
      ["priscilla", "published"],
      ["tom", "published"],
    ]);
    expect(result.authors.find((a) => a.author === "alice")?.evergreen).toBe(true);
    expect(result.authors.find((a) => a.author === "alice")?.sourceArticleIds).toBeUndefined();
    expect(result.authors.find((a) => a.author === "priscilla")?.evergreen).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.gate).toBeUndefined();
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(logs.some((l) => l.includes("TOPIC GATE FAILED CLOSED"))).toBe(true);
    expect(logs.some((l) => l.includes("alice → evergreen fallback"))).toBe(true);
  });

  it("a null gate response drives the same evergreen fallback", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return null;
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG,manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });
    const alice = result.authors.find((a) => a.author === "alice");
    expect(alice?.status).toBe("published");
    expect(alice?.evergreen).toBe(true);
  });

  it("zero candidates in the window: news publish evergreen WITHOUT any gate call", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isBriefCall(prompt) ? briefJson() : pieceFor(prompt, 1600)),
    });
    const result = await runOpinions(CONFIG,
      manifestOf(story("old", { firstSeen: "2026-07-10T10:00:00.000Z" })),
      sundayAssets(),
      { generate, now: fixedNow(NOW) },
    );

    expect(generate.calls.filter(isGateCall)).toHaveLength(0);
    const bob = result.authors.find((a) => a.author === "bob");
    expect(bob?.status).toBe("published");
    expect(bob?.evergreen).toBe(true);
    expect(result.authors.find((a) => a.author === "tom")?.status).toBe("published");
  });
});

describe("runOpinions — failure isolation + length sanity", () => {
  it("one author's null generation fails only that author; the run stays ok", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return briefJson();
        return prompt.includes("You are alice") ? null : pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG,manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });

    expect(result.authors.find((a) => a.author === "alice")).toMatchObject({
      status: "failed",
      detail: "generation returned null",
    });
    expect(result.authors.filter((a) => a.status === "published")).toHaveLength(3);
    expect(result.ok).toBe(true);
    expect(result.manifest.stories["opinion-alice-2026-07-12"]).toBeUndefined();
  });

  it("ok:false only when EVERY author failed", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isGateCall(prompt) ? verdictsJson(["s1"]) : null),
    });
    const result = await runOpinions(CONFIG,manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });

    expect(result.authors.every((a) => a.status === "failed")).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("output without a title line or body fails that author", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) =>
        isGateCall(prompt) ? verdictsJson(["s1"]) : "a single line with no body",
    });
    const result = await runOpinions(CONFIG,manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });
    expect(result.authors.find((a) => a.author === "alice")).toMatchObject({
      status: "failed",
      detail: "output missing title line or body",
    });
  });

  it("retries a malformed piece in-cycle and publishes on the second attempt (ADR-0023)", async () => {
    let aliceCalls = 0;
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return briefJson();
        if (prompt.includes("You are alice")) {
          aliceCalls++;
          return aliceCalls === 1 ? "a single line with no body" : pieceFor(prompt, 1600);
        }
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });
    expect(result.authors.find((a) => a.author === "alice")).toMatchObject({ status: "published" });
    expect(aliceCalls).toBe(2); // one retry, then success
    expect(result.manifest.stories["opinion-alice-2026-07-12"]).toBeDefined();
  });

  it("stops retrying after MAX_PIECE_ATTEMPTS and fails the author", async () => {
    let aliceCalls = 0;
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return briefJson();
        if (prompt.includes("You are alice")) {
          aliceCalls++;
          return "a single line with no body"; // never recovers
        }
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });
    expect(result.authors.find((a) => a.author === "alice")).toMatchObject({
      status: "failed",
      detail: "output missing title line or body",
    });
    expect(aliceCalls).toBe(MAX_PIECE_ATTEMPTS); // bounded — no runaway retries
    expect(result.manifest.stories["opinion-alice-2026-07-12"]).toBeUndefined();
  });

  it("re-rolls a letter column that omits the reader's letter, publishing once it includes it (ADR-0031)", async () => {
    let tomCalls = 0;
    const letterless = `A Title\n\nA lovely question, Wanda. ${"word ".repeat(1600).trim()}`;
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isBriefCall(prompt)) return briefJson();
        if (prompt.includes("You are tom")) {
          tomCalls++;
          return tomCalls === 1 ? letterless : pieceFor(prompt, 1600);
        }
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["tom"] });
    expect(result.authors[0]).toMatchObject({ author: "tom", status: "published" });
    expect(tomCalls).toBe(2); // first (letterless) rejected, second (with letter) publishes
    expect(result.manifest.stories["opinion-tom-2026-07-12"].description).toContain("Dear Tom,");
  });

  it("fails a letter column closed when the letter never appears (ADR-0031)", async () => {
    const letterless = `A Title\n\nA lovely question, Wanda. ${"word ".repeat(1600).trim()}`;
    const generate = fakeTextGenerator({
      impl: (prompt) => (isBriefCall(prompt) ? briefJson() : letterless),
    });
    const result = await runOpinions(CONFIG, manifestOf(), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["priscilla"] });
    expect(result.authors[0]).toMatchObject({
      author: "priscilla",
      status: "failed",
      detail: "letter column is missing the reader's letter",
    });
    expect(result.manifest.stories["opinion-priscilla-2026-07-12"]).toBeUndefined();
  });

  it("length: >2x out of band fails; merely out of range publishes with a warning", async () => {
    const logs: string[] = [];
    // alice (1400–2000): 300 words < 700 → FAIL. bob (1200–1600): 900 words → warn+publish.
    // tom (1200–1600): 300 words < 600 → FAIL. priscilla (1200–1600): 1400 → clean publish.
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return briefJson();
        if (prompt.includes("You are alice")) return piece(300);
        if (prompt.includes("You are bob")) return piece(900);
        if (prompt.includes("You are tom")) return pieceFor(prompt, 300);
        return pieceFor(prompt, 1400);
      },
    });
    const result = await runOpinions(CONFIG,manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
      log: (m) => logs.push(m),
    });

    expect(result.authors.map((a) => [a.author, a.status])).toEqual([
      ["alice", "failed"],
      ["bob", "published"],
      ["priscilla", "published"],
      ["tom", "failed"],
    ]);
    expect(result.authors.find((a) => a.author === "alice")?.detail).toContain("out of band");
    expect(result.authors.find((a) => a.author === "tom")?.detail).toContain("1200-1600");
    expect(logs.some((l) => l.includes("bob length warning — 900 words"))).toBe(true);
  });
});

describe("image brief (ADR-0016) — prompt, parse, all-or-nothing", () => {
  it("news brief prompt carries the piece + source articles + the hard visual rules", () => {
    const alice = newsPersona("alice");
    const prompt = buildImageBriefPrompt(alice, "The Title", "The body.", [
      story("s1"),
      story("s2"),
    ]);

    expect(prompt).toContain("Title: The Title");
    expect(prompt).toContain("The body.");
    expect(prompt).toContain("ARTICLE 1:\nHeadline s1");
    expect(prompt).toContain("ARTICLE 2:");
    expect(prompt).toContain("the news story the piece reacts to");
    // The story-convention hard rules (mirrors src/prompt.ts).
    expect(prompt).toContain("PURELY VISUAL");
    expect(prompt).toContain("NO text, letters, numbers");
    expect(prompt).toContain("NO brand names, trademarks");
    expect(prompt).toContain("as if photographed");
    expect(prompt).toContain("Do NOT stylize");
    expect(prompt).toContain("never the author");
    // No named real people in the scene (ADR-0024): Grok refuses from-scratch likenesses.
    expect(prompt).toContain("identifiable people");
    expect(prompt).toContain("generic role");
    expect(prompt).toContain("STRICT JSON");
    // The persona voice prompt is NOT part of the brief.
    expect(prompt).not.toContain(alice.body);
  });

  it("letters brief prompt keys the subject off the invented letter, no articles", () => {
    const tom = lettersPersona("tom", ["mon"]);
    const prompt = buildImageBriefPrompt(tom, "The Title", "The body.", []);
    expect(prompt).toContain("reader letter");
    expect(prompt).not.toContain("ARTICLE");
    expect(prompt).not.toContain("SOURCE ARTICLES");
  });

  it("parseImageBrief accepts strict/fenced/prose-wrapped JSON and trims", () => {
    const json = JSON.stringify({ imagePrompt: "  a scene  ", caption: " a line " });
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Here!\n${json}\nEnjoy.`]) {
      expect(parseImageBrief(text)).toEqual({ imagePrompt: "a scene", caption: "a line" });
    }
  });

  it.each([
    ["not JSON", "no json here"],
    ["missing imagePrompt", JSON.stringify({ caption: "a line" })],
    ["missing caption", JSON.stringify({ imagePrompt: "a scene" })],
    ["empty imagePrompt", JSON.stringify({ imagePrompt: "  ", caption: "a line" })],
    ["non-string caption", JSON.stringify({ imagePrompt: "a scene", caption: 7 })],
    ["array with no object inside", JSON.stringify(["a scene", "a line"])],
  ])("parseImageBrief rejects %s → null", (_label, text) => {
    expect(parseImageBrief(text)).toBeNull();
  });

  it("a failed brief fails the author and stores NO record — the key stays free", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return "I refuse to emit JSON";
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["alice"] });

    expect(result.authors[0]).toMatchObject({
      author: "alice",
      status: "failed",
      detail: "image brief derivation failed",
    });
    expect(result.manifest.stories["opinion-alice-2026-07-12"]).toBeUndefined();
    expect(result.ok).toBe(false); // the only derived author failed
  });

  it("a null brief response fails the same way", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (isBriefCall(prompt)) return null;
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["bob"] });
    expect(result.authors[0].status).toBe("failed");
    expect(result.manifest.stories["opinion-bob-2026-07-12"]).toBeUndefined();
  });
});

describe("runOpinions — dry-run", () => {
  it("runs gate + selection only: would-publish keys, zero piece calls, manifest untouched", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isGateCall(prompt) ? verdictsJson(["s1", "s2"]) : pieceFor(prompt, 1600)),
    });
    const starting = manifestOf(story("s1"), story("s2"));
    const result = await runOpinions(CONFIG,starting, sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { dryRun: true });

    expect(result.manifest).toBe(starting); // the exact input object, untouched
    expect(Object.keys(starting.stories)).toHaveLength(2);
    expect(generate.calls).toHaveLength(1); // the gate call ONLY
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(generate.calls.filter(isBriefCall)).toHaveLength(0); // no briefs either
    expect(result.gate).toHaveLength(2);
    expect(result.authors.every((a) => a.status === "would-publish")).toBe(true);
    expect(result.authors.map((a) => a.key)).toEqual([
      "opinion-alice-2026-07-12",
      "opinion-bob-2026-07-12",
      "opinion-priscilla-2026-07-12",
      "opinion-tom-2026-07-12",
    ]);
    const alice = result.authors.find((a) => a.author === "alice");
    expect(alice?.sourceArticleIds?.length).toBeGreaterThanOrEqual(1);
  });

  it("--date shifts derivation and keys (Monday → pair + tom only)", async () => {
    const generate = fakeTextGenerator({ impl: () => verdictsJson([]) });
    const result = await runOpinions(CONFIG,
      manifestOf(),
      assetsOf(
        newsPersona("edgar"),
        newsPersona("stryker"),
        lettersPersona("tom", ["mon", "wed", "fri", "sun"]),
        lettersPersona("priscilla", ["tue", "thu", "sat", "sun"]),
      ),
      { generate, now: fixedNow(NOW) },
      { date: "2026-07-13", dryRun: true },
    );

    expect(result.authors.map((a) => a.author)).toEqual(["edgar", "stryker", "tom"]);
    expect(result.authors[0].key).toBe("opinion-edgar-2026-07-13");
  });
});

describe("beforeOpinionPublishHour (ADR-0018) — >= boundary, never ==", () => {
  it("is closed strictly before the hour and open at/after it", () => {
    expect(beforeOpinionPublishHour(new Date("2026-07-12T12:59:59Z"), 13)).toBe(true);
    expect(beforeOpinionPublishHour(new Date("2026-07-12T13:00:00Z"), 13)).toBe(false);
    // >= not ==: a missed 13:00 tick self-heals at 14:00.
    expect(beforeOpinionPublishHour(new Date("2026-07-12T14:00:00Z"), 13)).toBe(false);
    expect(beforeOpinionPublishHour(new Date("2026-07-12T00:00:00Z"), 0)).toBe(false);
  });
});

describe("gateSummary (ADR-0018) — one line per topic-gate outcome", () => {
  it("reports the pass ratio when the gate runs clean", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1", "s2"], ["s2"]);
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(CONFIG, manifestOf(story("s1"), story("s2")), assetsOf(newsPersona("alice")), { generate, now: fixedNow(NOW) }, { authors: ["alice"] });
    expect(result.gateSummary).toBe("gate passed 1/2 candidate(s) via Claude");
  });

  it("reports fail-closed with the excluded count on a provider error", async () => {
    const generate = fakeTextGenerator({ impl: () => { throw new Error("provider down"); } });
    const result = await runOpinions(CONFIG, manifestOf(story("s1"), story("s2")), assetsOf(newsPersona("alice")), { generate, now: fixedNow(NOW) }, { authors: ["alice"] });
    expect(result.gateSummary).toBe("gate failed closed (2 candidate(s) excluded)");
  });

  it("FAILS OVER to the Claude gate when the TTS gate is unavailable (owner directive 2026-07-14)", async () => {
    // TTS gate down (null); the incumbent Claude generate still classifies → the news author
    // publishes and the summary records the failover, instead of the old fail-closed behavior.
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1", "s2"], ["s2"]); // s1 eligible
        if (isBriefCall(prompt)) return briefJson();
        return pieceFor(prompt, 1600);
      },
    });
    const result = await runOpinions(
      CONFIG,
      manifestOf(story("s1"), story("s2")),
      assetsOf(newsPersona("alice")),
      { generate, now: fixedNow(NOW), ttsGate: async () => null },
      { authors: ["alice"] },
    );
    expect(result.gateSummary).toBe("gate passed 1/2 candidate(s) via Claude (TTS failover)");
    expect(result.authors.find((a) => a.author === "alice")?.status).toBe("published");
  });

  it("fails closed only when BOTH the TTS gate and the Claude fallback fail", async () => {
    const generate = fakeTextGenerator({ impl: () => { throw new Error("claude down too"); } });
    const result = await runOpinions(
      CONFIG,
      manifestOf(story("s1"), story("s2")),
      assetsOf(newsPersona("alice")),
      { generate, now: fixedNow(NOW), ttsGate: async () => null },
      { authors: ["alice"] },
    );
    expect(result.gateSummary).toBe("gate failed closed (2 candidate(s) excluded)");
  });

  it("reports 'gate not run' on a letters-only day and '(no candidates)' on an empty pool", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isBriefCall(prompt) ? briefJson() : pieceFor(prompt, 1600)),
    });
    const letters = await runOpinions(CONFIG, manifestOf(), assetsOf(lettersPersona("tom", ["sun"])), { generate, now: fixedNow(NOW) });
    expect(letters.gateSummary).toBe("gate not run");

    const empty = await runOpinions(CONFIG, manifestOf(), assetsOf(newsPersona("alice")), { generate: fakeTextGenerator(), now: fixedNow(NOW) }, { authors: ["alice"] });
    expect(empty.gateSummary).toBe("gate not run (no candidates)");
  });
});

describe("opinionsStageOutcome (ADR-0018) — the cycle's structured health record", () => {
  it("buckets author keys by status and passes the gate summary through", () => {
    const outcome = opinionsStageOutcome({
      date: TODAY,
      authors: [
        { author: "alice", key: "opinion-alice-2026-07-12", status: "published" },
        { author: "bob", key: "opinion-bob-2026-07-12", status: "skipped-no-candidates" },
        { author: "priscilla", key: "opinion-priscilla-2026-07-12", status: "skipped-idempotent" },
        { author: "tom", key: "opinion-tom-2026-07-12", status: "failed", detail: "boom" },
      ],
      gateSummary: "gate passed 1/3 candidate(s)",
      manifest: manifestOf(),
      ok: true,
    });
    expect(outcome).toEqual({
      status: "ran",
      published: ["opinion-alice-2026-07-12"],
      skippedIdempotent: ["opinion-priscilla-2026-07-12"],
      failed: ["opinion-tom-2026-07-12"],
      gateSummary: "gate passed 1/3 candidate(s)",
    });
  });
});

describe("opinionStaleness (ADR-0018) — the >36h / empty-store invariant", () => {
  /** An OPINION record whose lastSeen is `hours` before NOW. */
  function opinion(id: string, hoursOld: number): ManifestRecord {
    const lastSeen = new Date(new Date(NOW).getTime() - hoursOld * 3600_000).toISOString();
    return story(id, { category: "OPINION", author: id.split("-")[1], lastSeen });
  }

  it("pins the threshold the schedule invariant derives", () => {
    expect(OPINION_STALE_THRESHOLD_HOURS).toBe(36);
  });

  it("an empty store is itself stale", () => {
    expect(opinionStaleness(manifestOf(), new Date(NOW))).toEqual({ stale: true, count: 0 });
  });

  it("is silent below the threshold, reporting age and newest key", () => {
    const m = manifestOf(opinion("opinion-tom-2026-07-12", 10));
    expect(opinionStaleness(m, new Date(NOW))).toEqual({
      stale: false,
      count: 1,
      ageHours: 10,
      newestKey: "opinion-tom-2026-07-12",
    });
  });

  it("fires past 36h, keying off the NEWEST record and ignoring non-OPINION stories", () => {
    const m = manifestOf(
      opinion("opinion-alice-2026-07-09", 80),
      opinion("opinion-tom-2026-07-11", 41),
      story("s1"), // fresh news story must not mask opinion staleness
    );
    expect(opinionStaleness(m, new Date(NOW))).toEqual({
      stale: true,
      count: 2,
      ageHours: 41,
      newestKey: "opinion-tom-2026-07-11",
    });
    // Exactly 36h is still healthy — the contract is strictly greater-than.
    const boundary = manifestOf(opinion("opinion-tom-2026-07-11", 36));
    expect(opinionStaleness(boundary, new Date(NOW)).stale).toBe(false);
  });
});

describe("runOpinions has no hour gate of its own (ADR-0018 CLI bypass)", () => {
  it("publishes at 05:00 UTC even with opinionPublishHourUTC 13", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isBriefCall(prompt) ? briefJson() : pieceFor(prompt, 1600)),
    });
    const result = await runOpinions(
      makeConfig({ opinionPublishHourUTC: 13 }),
      manifestOf(),
      assetsOf(lettersPersona("tom", ["sun"])),
      { generate, now: fixedNow("2026-07-12T05:00:00.000Z") },
    );
    expect(result.authors).toMatchObject([{ author: "tom", status: "published" }]);
  });
});
