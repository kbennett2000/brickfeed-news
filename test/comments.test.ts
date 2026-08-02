import { describe, expect, it } from "vitest";
import {
  buildCommentsPrompt,
  finalizeReactions,
  hotCommentIds,
  MAX_COMMENT_BODY_CHARS,
  MAX_USERNAME_CHARS,
  mintComments,
  parseComments,
  runComments,
  summarizeComments,
} from "../src/comments.js";
import {
  ARGUMENT_MOVES,
  buildDeck,
  type CommentDeck,
  dealDeck,
  OFF_TOPIC_THEMES,
  renderDeck,
  RETIRED_GAGS,
} from "../src/comments-flavor.js";
import { buildCommentTree, COMMENT_DISPLAY_DEPTH, toStoryView } from "../src/render/index.js";
import { COMMENTS_DISCLOSURE, commentThread } from "../src/render/templates.js";
import type { Comment, Manifest, ManifestRecord } from "../src/types.js";
import { fakeTextGenerator, fixedNow, makeConfig } from "./helpers.js";

const NOW = "2026-07-10T12:00:00.000Z";

/** A publishable OPINION record (isPublishable + isOpinionRecord both true). */
function opinionRecord(id: string, over: Partial<ManifestRecord> = {}): ManifestRecord {
  return {
    id,
    url: "",
    sourceName: "",
    title: "A Very Serious Column",
    headline: "A Very Serious Column",
    description: "The framers would be appalled. ".repeat(20),
    imagePrompt: "a scene",
    wrappedPrompt: `TEST-STYLE scene ${id}`,
    category: "OPINION",
    caption: "a neutral scene",
    imageUrl: `https://cdn.test/${id}.png`,
    imageStoredAt: NOW,
    author: "alice",
    firstSeen: NOW,
    lastSeen: NOW,
    ...over,
  };
}

function manifestOf(...records: ManifestRecord[]): Manifest {
  const stories: Record<string, ManifestRecord> = {};
  for (const r of records) stories[r.id] = r;
  return { version: 1, stories };
}

/** A generator whose completion is a fixed JSON batch of the given raw comments. */
function batchGen(comments: Array<{ username: string; body: string; replyTo?: string | null }>) {
  return fakeTextGenerator({
    impl: () =>
      JSON.stringify({ comments: comments.map((c) => ({ replyTo: null, ...c })) }),
  });
}

const CONFIG = makeConfig({
  comments: {
    enabled: true,
    initialCount: 3,
    perPassCount: 2,
    maxPerPiece: 5,
    growWindowHours: 72,
    model: "test-comments-model",
  },
});

const ASSETS = { personas: [], shared: "", letters: "", comments: "COMMENT RULES" };

describe("parseComments", () => {
  it("parses a valid batch into raw comments", () => {
    const text = JSON.stringify({
      comments: [
        { username: "rickp53", body: "Article 9 clearly states this", replyTo: null },
        { username: "2nd-ID-7682", body: "finish high school", replyTo: "c1" },
      ],
    });
    const out = parseComments(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ username: "rickp53", body: "Article 9 clearly states this", replyTo: null });
    expect(out[1].replyTo).toBe("c1");
  });

  it("returns [] on non-JSON, missing array, or wrong shape", () => {
    expect(parseComments("not json at all")).toEqual([]);
    expect(parseComments(JSON.stringify({ nope: 1 }))).toEqual([]);
    expect(parseComments(JSON.stringify({ comments: "x" }))).toEqual([]);
    expect(parseComments(JSON.stringify([{ username: "a", body: "b" }]))).toEqual([]);
  });

  it("drops items missing a string username or body, keeps the rest", () => {
    const text = JSON.stringify({
      comments: [
        { username: "ok", body: "kept" },
        { username: "", body: "empty user" },
        { username: "nobody", body: "" },
        { body: "no user" },
        { username: "still-here", body: "kept too" },
      ],
    });
    const out = parseComments(text);
    expect(out.map((c) => c.username)).toEqual(["ok", "still-here"]);
  });

  it("drops a leaked refusal/preamble body but keeps clean siblings", () => {
    const text = JSON.stringify({
      comments: [
        { username: "leaky", body: "I can't help with that request." },
        { username: "clean", body: "Both." },
      ],
    });
    const out = parseComments(text);
    expect(out.map((c) => c.username)).toEqual(["clean"]);
  });

  it("drops over-length usernames and bodies", () => {
    const text = JSON.stringify({
      comments: [
        { username: "x".repeat(MAX_USERNAME_CHARS + 1), body: "hi" },
        { username: "ok", body: "y".repeat(MAX_COMMENT_BODY_CHARS + 1) },
        { username: "fine", body: "short" },
      ],
    });
    expect(parseComments(text).map((c) => c.username)).toEqual(["fine"]);
  });

  it("REJECTS the whole batch (returns []) when any comment contains a link", () => {
    const text = JSON.stringify({
      comments: [
        { username: "ok", body: "totally fine" },
        { username: "spammer", body: "buy now at scam.com" },
      ],
    });
    expect(parseComments(text)).toEqual([]);
  });

  it("REJECTS the whole batch when any comment trips the violence denylist", () => {
    const text = JSON.stringify({
      comments: [
        { username: "ok", body: "fine" },
        { username: "mean", body: "kys" },
      ],
    });
    expect(parseComments(text)).toEqual([]);
  });
});

describe("mintComments", () => {
  it("mints append-only ids from the existing thread length", () => {
    const rec = opinionRecord("p", { comments: [c("p-c0"), c("p-c1")] });
    const minted = mintComments(
      [{ username: "u", body: "b", replyTo: null }],
      rec,
      new Date(NOW),
    );
    expect(minted[0].id).toBe("p-c2");
    expect(minted[0].createdAt).toBe(NOW);
  });

  it("resolves replyTo: existing id, earlier new:N, else null", () => {
    const rec = opinionRecord("p", { comments: [c("p-c0")] });
    const minted = mintComments(
      [
        { username: "a", body: "1", replyTo: "p-c0" }, // existing → resolves
        { username: "b", body: "2", replyTo: "new:0" }, // earlier new → the first minted
        { username: "c", body: "3", replyTo: "new:2" }, // self/forward → null
        { username: "d", body: "4", replyTo: "p-c99" }, // unknown existing → null
      ],
      rec,
      new Date(NOW),
    );
    expect(minted[0].parentId).toBe("p-c0");
    expect(minted[1].parentId).toBe("p-c1"); // new:0 = first minted this batch
    expect(minted[2].parentId).toBeNull();
    expect(minted[3].parentId).toBeNull();
  });
});

describe("finalizeReactions", () => {
  it("is deterministic for a given id", () => {
    expect(finalizeReactions("p-c3")).toEqual(finalizeReactions("p-c3"));
  });

  it("produces a long tail — most low, a few high — across many ids", () => {
    const ups = Array.from({ length: 400 }, (_, i) => finalizeReactions(`p-c${i}`).up);
    expect(Math.max(...ups)).toBeGreaterThan(150); // at least one spike
    expect(ups.filter((u) => u < 15).length).toBeGreaterThan(200); // most are small
  });
});

describe("hotCommentIds", () => {
  it("ranks by up + 3·replies + laugh", () => {
    const comments = [
      c("a", { reactions: { up: 5, down: 0, laugh: 0, flag: 0 } }),
      c("b", { reactions: { up: 100, down: 0, laugh: 0, flag: 0 } }),
      c("r1", { parentId: "a" }),
      c("r2", { parentId: "a" }),
      c("r3", { parentId: "a" }),
    ];
    // a: 5 + 3*3 = 14 ... but b has 100 → b hottest, then a.
    const hot = hotCommentIds(comments, 2);
    expect(hot.has("b")).toBe(true);
    expect(hot.has("a")).toBe(true);
  });
});

const DECK: CommentDeck = buildDeck("p", 0);

describe("buildCommentsPrompt", () => {
  it("includes the guardrail block, the headline/excerpt, and the JSON contract when seeding", () => {
    const rec = opinionRecord("p");
    const prompt = buildCommentsPrompt("COMMENT RULES HERE", rec, [], { count: 3, mode: "seed" }, new Set(), DECK);
    expect(prompt).toContain("COMMENT RULES HERE");
    expect(prompt).toContain(rec.headline!);
    expect(prompt).toContain("BRAND NEW");
    expect(prompt).toContain('"comments"');
  });

  it("lists existing comments with ids/usernames and flags the hot ones when growing", () => {
    const existing = [c("p-c0", { username: "rickp53", body: "Article 9" })];
    const prompt = buildCommentsPrompt("RULES", opinionRecord("p"), existing, { count: 2, mode: "grow" }, new Set(["p-c0"]), DECK);
    expect(prompt).toContain("p-c0");
    expect(prompt).toContain("rickp53");
    expect(prompt).toContain("[HOT]");
  });

  it("injects the FRESH ANGLES deck and the retired-gags avoid list (ADR-0029)", () => {
    const prompt = buildCommentsPrompt("RULES", opinionRecord("p"), [], { count: 3, mode: "seed" }, new Set(), DECK);
    expect(prompt).toContain("FRESH ANGLES FOR THIS THREAD");
    expect(prompt).toContain("AVOID falling back on");
    for (const gag of RETIRED_GAGS) expect(prompt).toContain(gag);
    // A dealt off-topic tangent is actually present in the prompt.
    expect(prompt).toContain(DECK.offTopic[0]);
  });
});

describe("comedy flavor deck (ADR-0029)", () => {
  it("dealDeck is deterministic for the same salt", () => {
    expect(dealDeck("s", OFF_TOPIC_THEMES, 3)).toEqual(dealDeck("s", OFF_TOPIC_THEMES, 3));
  });

  it("dealDeck returns k DISTINCT items", () => {
    const hand = dealDeck("s", OFF_TOPIC_THEMES, 5);
    expect(hand).toHaveLength(5);
    expect(new Set(hand).size).toBe(5);
  });

  it("dealDeck clamps k to the bank size (never loops forever)", () => {
    const hand = dealDeck("s", ARGUMENT_MOVES, ARGUMENT_MOVES.length + 10);
    expect(hand).toHaveLength(ARGUMENT_MOVES.length);
    expect(new Set(hand).size).toBe(ARGUMENT_MOVES.length);
  });

  it("buildDeck diverges across piece ids (the whole point)", () => {
    const a = buildDeck("opinion-alice-2026-07-24", 0);
    const b = buildDeck("opinion-hodge-2026-07-24", 0);
    expect(a.offTopic).not.toEqual(b.offTopic);
  });

  it("buildDeck is reproducible for the same (piece, length)", () => {
    expect(buildDeck("p", 4)).toEqual(buildDeck("p", 4));
  });

  it("buildDeck rotates the hand as the thread grows", () => {
    expect(buildDeck("p", 0).offTopic).not.toEqual(buildDeck("p", 5).offTopic);
  });

  it("the recurring-cast cameo is gated to roughly a third of threads", () => {
    let cameos = 0;
    for (let i = 0; i < 300; i++) if (buildDeck(`piece-${i}`, 0).cameo) cameos++;
    // Gate is hash % 3 === 0 → ~1/3; assert a loose band so it can't silently become always/never.
    expect(cameos).toBeGreaterThan(60);
    expect(cameos).toBeLessThan(160);
  });

  it("renderDeck names the retired gags and, when no cameo, forbids regulars", () => {
    const noCameo: CommentDeck = {
      offTopic: ["x"],
      argumentMoves: ["y"],
      usernameStyle: "z",
      shapeEmphasis: "w",
      cameo: null,
    };
    const text = renderDeck(noCameo);
    expect(text).toContain("ALL-FRESH invented usernames");
    for (const gag of RETIRED_GAGS) expect(text).toContain(gag);
  });
});

describe("runComments — seed / grow / bounds", () => {
  it("seeds initialCount comments on a brand-new piece (capping model over-production)", async () => {
    const gen = batchGen([
      { username: "a1", body: "one" },
      { username: "a2", body: "two" },
      { username: "a3", body: "three", replyTo: "new:0" },
      { username: "a4", body: "four" },
      { username: "a5", body: "five" },
    ]);
    const res = await runComments(CONFIG, manifestOf(opinionRecord("p")), ASSETS, {
      generate: gen,
      now: fixedNow(NOW),
    });
    const stored = res.manifest.stories["p"].comments!;
    expect(stored).toHaveLength(3); // initialCount, not the 5 produced
    expect(stored.map((s) => s.id)).toEqual(["p-c0", "p-c1", "p-c2"]);
    expect(stored[2].parentId).toBe("p-c0"); // new:0 resolved
    expect(res.pieces[0]).toMatchObject({ id: "p", status: "seeded", added: 3 });
    expect(res.ok).toBe(true);
  });

  it("grows an existing thread by perPassCount and keeps ids monotonic", async () => {
    const rec = opinionRecord("p", { comments: [c("p-c0"), c("p-c1")] });
    const gen = batchGen([
      { username: "b1", body: "more" },
      { username: "b2", body: "yet more" },
      { username: "b3", body: "too many" },
    ]);
    const res = await runComments(CONFIG, manifestOf(rec), ASSETS, { generate: gen, now: fixedNow(NOW) });
    const stored = res.manifest.stories["p"].comments!;
    expect(stored.map((s) => s.id)).toEqual(["p-c0", "p-c1", "p-c2", "p-c3"]); // +2
    expect(res.pieces[0]).toMatchObject({ status: "grew", added: 2 });
  });

  it("respects maxPerPiece — requests only the remaining slots", async () => {
    const rec = opinionRecord("p", {
      comments: [c("p-c0"), c("p-c1"), c("p-c2"), c("p-c3")], // 4 of cap 5
    });
    const gen = batchGen([
      { username: "x", body: "1" },
      { username: "y", body: "2" },
    ]);
    const res = await runComments(CONFIG, manifestOf(rec), ASSETS, { generate: gen, now: fixedNow(NOW) });
    expect(res.manifest.stories["p"].comments).toHaveLength(5); // capped, only 1 added
    expect(res.pieces[0].added).toBe(1);
  });

  it("skips a capped thread with no generator call", async () => {
    const rec = opinionRecord("p", {
      comments: Array.from({ length: 5 }, (_, i) => c(`p-c${i}`)),
    });
    const gen = batchGen([{ username: "x", body: "1" }]);
    const res = await runComments(CONFIG, manifestOf(rec), ASSETS, { generate: gen, now: fixedNow(NOW) });
    expect(res.pieces[0].status).toBe("skipped-capped");
    expect(gen.calls).toHaveLength(0);
  });

  it("freezes a piece older than growWindowHours (no generator call)", async () => {
    const old = new Date(Date.parse(NOW) - 100 * 3600_000).toISOString();
    const rec = opinionRecord("p", { firstSeen: old, comments: [c("p-c0")] });
    const gen = batchGen([{ username: "x", body: "1" }]);
    const res = await runComments(CONFIG, manifestOf(rec), ASSETS, { generate: gen, now: fixedNow(NOW) });
    expect(res.pieces[0].status).toBe("skipped-frozen");
    expect(gen.calls).toHaveLength(0);
  });

  it("skips non-opinion and non-publishable records entirely", async () => {
    const nonOpinion = opinionRecord("world", { author: undefined, category: "WORLD" });
    const imageless = opinionRecord("noimg", { imageUrl: undefined });
    const gen = batchGen([{ username: "x", body: "1" }]);
    const res = await runComments(CONFIG, manifestOf(nonOpinion, imageless), ASSETS, {
      generate: gen,
      now: fixedNow(NOW),
    });
    expect(res.pieces).toHaveLength(0);
    expect(gen.calls).toHaveLength(0);
  });

  it("isolates a per-piece failure — one bad piece never stops the others", async () => {
    const good = opinionRecord("good");
    const bad = opinionRecord("bad", { headline: "BadPiece", title: "BadPiece" });
    const gen = fakeTextGenerator({
      impl: (p) => (p.includes("BadPiece") ? null : JSON.stringify({ comments: [{ username: "u", body: "b", replyTo: null }] })),
    });
    const res = await runComments(CONFIG, manifestOf(good, bad), ASSETS, { generate: gen, now: fixedNow(NOW) });
    const byId = Object.fromEntries(res.pieces.map((p) => [p.id, p.status]));
    expect(byId["good"]).toBe("seeded");
    expect(byId["bad"]).toBe("failed");
    expect(res.manifest.stories["good"].comments).toHaveLength(1);
    expect(res.manifest.stories["bad"].comments).toBeUndefined();
  });

  it("a null completion fails the piece and leaves it unchanged; ok is false", async () => {
    const gen = fakeTextGenerator({ impl: () => null });
    const res = await runComments(CONFIG, manifestOf(opinionRecord("p")), ASSETS, {
      generate: gen,
      now: fixedNow(NOW),
    });
    expect(res.pieces[0].status).toBe("failed");
    expect(res.manifest.stories["p"].comments).toBeUndefined();
    expect(res.ok).toBe(false);
  });

  it("enabled:false skips the stage entirely (zero calls, no outcomes)", async () => {
    const cfg = makeConfig({ comments: { ...CONFIG.comments, enabled: false } });
    const gen = batchGen([{ username: "x", body: "1" }]);
    const res = await runComments(cfg, manifestOf(opinionRecord("p")), ASSETS, { generate: gen, now: fixedNow(NOW) });
    expect(res.pieces).toHaveLength(0);
    expect(gen.calls).toHaveLength(0);
  });

  it("dry-run makes no generator calls and leaves the manifest untouched", async () => {
    const start = manifestOf(opinionRecord("p"));
    const gen = batchGen([{ username: "x", body: "1" }]);
    const res = await runComments(CONFIG, start, ASSETS, { generate: gen, now: fixedNow(NOW) }, { dryRun: true });
    expect(gen.calls).toHaveLength(0);
    expect(res.manifest.stories["p"].comments).toBeUndefined();
    expect(res.pieces[0].detail).toContain("would seed");
  });

  it("summarizeComments reports the outcome mix", async () => {
    const gen = batchGen([{ username: "x", body: "1" }]);
    const res = await runComments(CONFIG, manifestOf(opinionRecord("p")), ASSETS, { generate: gen, now: fixedNow(NOW) });
    expect(summarizeComments(res)).toContain("seeded");
  });
});

describe("buildCommentTree", () => {
  it("nests replies under parents, top-level newest-first", () => {
    const comments = [
      c("c0", { username: "first" }),
      c("c1", { username: "reply-to-first", parentId: "c0" }),
      c("c2", { username: "second-top" }),
    ];
    const tree = buildCommentTree(comments, "UTC");
    expect(tree.map((n) => n.username)).toEqual(["second-top", "first"]); // newest-first roots
    expect(tree[1].replies.map((r) => r.username)).toEqual(["reply-to-first"]);
  });

  it("caps display depth, flattening a deep chain onto the deepest allowed ancestor", () => {
    const comments = [
      c("c0"),
      c("c1", { parentId: "c0" }),
      c("c2", { parentId: "c1" }),
      c("c3", { parentId: "c2" }), // would be depth 3 → flattened
      c("c4", { parentId: "c3" }), // would be depth 4 → flattened
    ];
    const tree = buildCommentTree(comments, "UTC");
    const depth = (nodes: ReturnType<typeof buildCommentTree>): number =>
      nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((n) => depth(n.replies)));
    expect(depth(tree)).toBeLessThanOrEqual(COMMENT_DISPLAY_DEPTH);
  });

  it("formats createdAt in the render timezone", () => {
    const tree = buildCommentTree([c("c0", { createdAt: NOW })], "UTC");
    expect(tree[0].timestamp).not.toBe("");
  });
});

describe("commentThread render", () => {
  it("escapes model-supplied username and body (XSS defense)", () => {
    const nodes = buildCommentTree(
      [c("c0", { username: "<script>evil</script>", body: "<img src=x onerror=alert(1)>" })],
      "UTC",
    );
    const html = commentThread(nodes);
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain(COMMENTS_DISCLOSURE);
  });

  it("renders nothing for an empty thread", () => {
    expect(commentThread([])).toBe("");
  });
});

describe("toStoryView — comment attachment", () => {
  it("attaches the comment tree only to opinion records that have comments", () => {
    const withComments = opinionRecord("p", { comments: [c("p-c0", { username: "u" })] });
    const view = toStoryView(withComments, "UTC");
    expect(view.comments).toBeDefined();
    expect(view.comments).toHaveLength(1);

    const noComments = opinionRecord("q");
    expect(toStoryView(noComments, "UTC").comments).toBeUndefined();
  });
});

/** A minimal stored Comment with sensible defaults. */
function c(id: string, over: Partial<Comment> = {}): Comment {
  return {
    id,
    username: `user-${id}`,
    body: "a comment",
    parentId: null,
    reactions: { up: 1, down: 0, laugh: 0, flag: 0 },
    createdAt: NOW,
    ...over,
  };
}
