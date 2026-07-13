import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_WINDOW_HOURS,
  DEFAULT_LENGTH_RANGE,
  LENGTH_RANGES,
  ROTATION,
  authorsFor,
  buildGatePrompt,
  buildOpinionPrompt,
  daysSinceUnixEpoch,
  opinionCandidates,
  opinionKey,
  parseGateVerdicts,
  runOpinions,
  splitTitleBody,
  summarizeOpinions,
  utcDateOf,
  weekdayOf,
  weightedSample,
} from "../src/opinions.js";
import type { OpinionAssets, Persona } from "../src/personas.js";
import type { Manifest, ManifestRecord } from "../src/types.js";
import { fakeTextGenerator, fixedNow, lettersPersona, newsPersona } from "./helpers.js";

/** 2026-07-12 is a Sunday: rotation index 20646 % 3 = 0 → alice+bob, plus both letters. */
const NOW = "2026-07-12T15:00:00.000Z";
const TODAY = "2026-07-12";

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

/** The full eight-persona roster (rotation members + both letters columnists). */
function fullRoster(): Persona[] {
  return [
    newsPersona("alice"),
    newsPersona("bob"),
    newsPersona("cynthia"),
    newsPersona("edgar"),
    newsPersona("larry"),
    newsPersona("stryker"),
    lettersPersona("priscilla", ["tue", "thu", "sat", "sun"]),
    lettersPersona("tom", ["mon", "wed", "fri", "sun"]),
  ];
}

function assetsOf(...personas: Persona[]): OpinionAssets {
  return { personas, shared: "SHARED RULES", letters: "LETTER RULES" };
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

const isGateCall = (prompt: string): boolean => prompt.includes("STORIES:");

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

  it("Sunday yields the pair plus BOTH letters personas (the intentional double)", () => {
    expect(names("2026-07-12")).toEqual(["alice", "bob", "priscilla", "tom"]);
  });

  it("walks the 3-day rotation with the scheduled letters overlay", () => {
    expect(names("2026-07-13")).toEqual(["edgar", "stryker", "tom"]); // Mon
    expect(names("2026-07-14")).toEqual(["larry", "cynthia", "priscilla"]); // Tue
    expect(names("2026-07-15")).toEqual(["alice", "bob", "tom"]); // Wed — wrapped
  });

  it("a rotation member missing from the roster is simply absent", () => {
    const noBob = fullRoster().filter((p) => p.name !== "bob");
    expect(names("2026-07-12", noBob)).toEqual(["alice", "priscilla", "tom"]);
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
    const candidates = [c("p", "POLITICS"), c("w", "WORLD"), c("s", "SPORTS")];
    const bias = { POLITICS: 3, WORLD: 1 }; // s → floor 0.25; total 4.25
    // roll 0 → lands in p's [0,3); then remaining total 1.25, roll 0.9*1.25=1.125 → s.
    const picked = weightedSample(candidates, bias, 2, seq(0, 0.9));
    expect(picked.map((r) => r.id)).toEqual(["p", "s"]);
  });

  it("an unlisted section is rare but reachable (floor weight, never zero)", () => {
    const candidates = [c("p", "POLITICS"), c("s", "SPORTS")];
    // total 3.25; roll 0.99*3.25 = 3.2175 > 3 → the floor-weighted SPORTS story.
    const picked = weightedSample(candidates, { POLITICS: 3 }, 1, seq(0.99));
    expect(picked.map((r) => r.id)).toEqual(["s"]);
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
    expect(prompt).toContain("300-500 word opinion piece");
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
    expect(prompt).toContain("invent the letter per your instructions above");
    expect(prompt).toContain("First line: a short original title");
    expect(prompt).not.toContain("ARTICLE");
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
    expect(splitTitleBody("just one line, no body")).toBeNull();
    expect(splitTitleBody("Title\n\n   ")).toBeNull();
    expect(splitTitleBody("")).toBeNull();
  });

  it("length ranges pin the persona prose (drift guard on the committed assets)", () => {
    expect(DEFAULT_LENGTH_RANGE).toEqual([300, 500]);
    expect(LENGTH_RANGES).toEqual({ tom: [500, 700] });
    // The constants mirror the spec-of-record in the persona PROSE — if a human edits
    // the .md ranges, this fails loud instead of silently mis-validating.
    expect(readFileSync("personas/_shared.md", "utf8")).toMatch(/300–500 words/);
    expect(readFileSync("personas/tom.md", "utf8")).toMatch(/500–700 words/);
  });
});

describe("runOpinions — publish path", () => {
  function happyGenerate() {
    return fakeTextGenerator({
      impl: (prompt) =>
        isGateCall(prompt) ? verdictsJson(["s2", "s1", "s3"]) : piece(350),
    });
  }

  it("Sunday launch: four authors publish; one gate call; records carry the contract fields", async () => {
    const generate = happyGenerate();
    const starting = manifestOf(story("s1"), story("s2"), story("s3"));
    const result = await runOpinions(starting, sundayAssets(), {
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
    expect(summarizeOpinions(result)).toBe("4 published, 0 skipped, 0 failed");
    // Exactly ONE gate classification for the whole 4-author run.
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(generate.calls).toHaveLength(5); // gate + 4 pieces
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
    expect(alice.imagePrompt).toBeUndefined();
    expect(alice.caption).toBeUndefined();

    const tom = result.manifest.stories["opinion-tom-2026-07-12"];
    expect(tom.columnTitle).toBe("tom's Column");
    expect(tom.sourceArticleIds).toBeUndefined();
  });

  it("gate-excluded stories never appear in sourceArticleIds", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) =>
        isGateCall(prompt) ? verdictsJson(["s2", "s1", "s3"], ["s2"]) : piece(350),
    });
    const result = await runOpinions(
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
    const result = await runOpinions(manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { authors: ["tom"] });

    expect(result.authors).toHaveLength(1);
    expect(result.authors[0]).toMatchObject({ author: "tom", status: "published" });
    expect(generate.calls.filter(isGateCall)).toHaveLength(0); // no news author → no gate

    await expect(
      runOpinions(manifestOf(), sundayAssets(), { generate, now: fixedNow(NOW) }, {
        authors: ["nobody"],
      }),
    ).rejects.toThrow('unknown persona "nobody"');
  });
});

describe("runOpinions — idempotency", () => {
  it("an existing key skips that author before any piece call", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isGateCall(prompt) ? verdictsJson(["s1"]) : piece(350)),
    });
    const seeded = story("opinion-alice-2026-07-12", { category: "OPINION", author: "alice" });
    const result = await runOpinions(manifestOf(story("s1"), seeded), sundayAssets(), {
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
    const result = await runOpinions(
      manifestOf(story("s1"), ...seeded),
      sundayAssets(),
      { generate, now: fixedNow(NOW) },
    );

    expect(generate.calls).toHaveLength(0);
    expect(result.authors.every((a) => a.status === "skipped-idempotent")).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("runOpinions — topic gate failure modes (fail-closed)", () => {
  it("a malformed gate response excludes everything: news skip, letters unaffected", async () => {
    const logs: string[] = [];
    const generate = fakeTextGenerator({
      impl: (prompt) => (isGateCall(prompt) ? "sorry, I cannot do JSON today" : piece(350)),
    });
    const result = await runOpinions(
      manifestOf(story("s1"), story("s2")),
      sundayAssets(),
      { generate, now: fixedNow(NOW), log: (m) => logs.push(m) },
    );

    expect(result.authors.map((a) => [a.author, a.status])).toEqual([
      ["alice", "skipped-no-candidates"],
      ["bob", "skipped-no-candidates"],
      ["priscilla", "published"],
      ["tom", "published"],
    ]);
    expect(result.authors[0].detail).toBe("topic gate failed closed");
    expect(result.ok).toBe(true); // skips are not failures
    expect(result.gate).toBeUndefined();
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
    expect(logs.some((l) => l.includes("TOPIC GATE FAILED CLOSED"))).toBe(true);
  });

  it("a null gate response fails closed the same way", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isGateCall(prompt) ? null : piece(350)),
    });
    const result = await runOpinions(manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });
    expect(result.authors.find((a) => a.author === "alice")?.status).toBe(
      "skipped-no-candidates",
    );
  });

  it("zero candidates in the window: news skip WITHOUT any gate call", async () => {
    const generate = fakeTextGenerator({ impl: () => piece(350) });
    const result = await runOpinions(
      manifestOf(story("old", { firstSeen: "2026-07-10T10:00:00.000Z" })),
      sundayAssets(),
      { generate, now: fixedNow(NOW) },
    );

    expect(generate.calls.filter(isGateCall)).toHaveLength(0);
    expect(result.authors.find((a) => a.author === "bob")?.status).toBe("skipped-no-candidates");
    expect(result.authors.find((a) => a.author === "tom")?.status).toBe("published");
  });
});

describe("runOpinions — failure isolation + length sanity", () => {
  it("one author's null generation fails only that author; the run stays ok", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        return prompt.includes("You are alice") ? null : piece(350);
      },
    });
    const result = await runOpinions(manifestOf(story("s1")), sundayAssets(), {
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
    const result = await runOpinions(manifestOf(story("s1")), sundayAssets(), {
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
    const result = await runOpinions(manifestOf(story("s1")), sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    });
    expect(result.authors.find((a) => a.author === "alice")).toMatchObject({
      status: "failed",
      detail: "output missing title line or body",
    });
  });

  it("length: >2x out of band fails; merely out of range publishes with a warning", async () => {
    const logs: string[] = [];
    // alice (300–500): 100 words < 150 → FAIL. bob (300–500): 250 words → warn+publish.
    // tom (500–700): 200 words < 250 → FAIL. priscilla (300–500): 350 → clean publish.
    const generate = fakeTextGenerator({
      impl: (prompt) => {
        if (isGateCall(prompt)) return verdictsJson(["s1"]);
        if (prompt.includes("You are alice")) return piece(100);
        if (prompt.includes("You are bob")) return piece(250);
        if (prompt.includes("You are tom")) return piece(200);
        return piece(350);
      },
    });
    const result = await runOpinions(manifestOf(story("s1")), sundayAssets(), {
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
    expect(result.authors.find((a) => a.author === "tom")?.detail).toContain("500-700");
    expect(logs.some((l) => l.includes("bob length warning — 250 words"))).toBe(true);
  });
});

describe("runOpinions — dry-run", () => {
  it("runs gate + selection only: would-publish keys, zero piece calls, manifest untouched", async () => {
    const generate = fakeTextGenerator({
      impl: (prompt) => (isGateCall(prompt) ? verdictsJson(["s1", "s2"]) : piece(350)),
    });
    const starting = manifestOf(story("s1"), story("s2"));
    const result = await runOpinions(starting, sundayAssets(), {
      generate,
      now: fixedNow(NOW),
    }, { dryRun: true });

    expect(result.manifest).toBe(starting); // the exact input object, untouched
    expect(Object.keys(starting.stories)).toHaveLength(2);
    expect(generate.calls).toHaveLength(1); // the gate call ONLY
    expect(generate.calls.filter(isGateCall)).toHaveLength(1);
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
    const result = await runOpinions(
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
