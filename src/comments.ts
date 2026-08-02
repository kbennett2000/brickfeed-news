/**
 * Parody reader-comments stage (ADR-0028): grows a fictional comment thread under every published
 * opinion piece. On each cycle it seeds a few comments on a brand-new piece, then appends more
 * comments + replies to still-growing pieces, until a piece leaves the grow window or hits the
 * per-piece cap. Comments are persisted APPEND-ONLY on the piece's ManifestRecord (`comments[]`),
 * so they grow across the 6-per-day cycles and are deleted with the piece at age-out — no separate
 * store, no second retention gate.
 *
 * Contracts that matter (mirroring the opinion stage):
 *  - Never trust the model for ids: comment ids are minted in code (`${pieceId}-c${n}`); the model
 *    only references existing comments by the ids we hand it, and unknown refs coerce to top-level.
 *  - Persist, don't derive: the stored array is the source of truth. Reaction tallies are finalized
 *    deterministically from `hashString(id)` (not the model, which clusters on round numbers), so a
 *    re-render is stable and a returning reader sees the same thread, just longer.
 *  - Fail closed: any null completion, empty/garbled parse, or guardrail hit leaves the thread
 *    untouched — the piece self-heals on the next of the 6 daily cycles. Per-piece try/catch, and
 *    the whole stage is wrapped by the cycle so a comment problem can never break the news cycle.
 *
 * All side-effects are injected (`CommentsDeps`); the manifest is copied, never mutated in place —
 * callers persist the returned manifest (dry-run returns the input untouched).
 */
import { buildDeck, type CommentDeck, renderDeck } from "./comments-flavor.js";
import type { Config } from "./config.js";
import { isOpinionRecord } from "./eligibility.js";
import { extractJsonObject } from "./generator/parse.js";
import type { TextGenerator } from "./generator/text.js";
import type { OpinionAssets } from "./personas.js";
import { isPublishable } from "./publish.js";
import { excerpt, hashString } from "./render/format.js";
import {
  containsLink,
  hasBannedContent,
  looksLikeMetaNarration,
  looksLikeRefusal,
  stripWrappingFence,
} from "./sanitize.js";
import type { Comment, Manifest, ManifestRecord } from "./types.js";

/** A comment body longer than this is leaked prose, not a comment — drop it. */
export const MAX_COMMENT_BODY_CHARS = 1200;
/** A username longer than this is leaked prose, not a handle — drop the comment. */
export const MAX_USERNAME_CHARS = 40;
/** How many hottest existing comments to flag as reply magnets in the prompt. */
const HOT_TARGETS = 3;
/**
 * How much of the piece body to feed as context. Enough for the model to misread THIS specific
 * column (which drives per-piece divergence, ADR-0029) — commenters still barely read the article,
 * but the seed leans on the real argument instead of generic off-topic filler.
 */
const BODY_CONTEXT_CHARS = 1100;

export interface CommentsDeps {
  /** The free-form text seam (createTextGenerator), pinned to `comments.model`. */
  generate: TextGenerator;
  now: () => Date;
  log?: (message: string) => void;
}

export interface CommentsOptions {
  /** Print what each piece WOULD do, make zero generator calls, leave the manifest untouched. */
  dryRun?: boolean;
}

export type PieceStatus =
  | "seeded"
  | "grew"
  | "skipped-frozen"
  | "skipped-capped"
  | "failed";

export interface PieceOutcome {
  id: string;
  status: PieceStatus;
  /** How many comments were actually appended this pass. */
  added: number;
  detail?: string;
}

export interface CommentsResult {
  manifest: Manifest;
  pieces: PieceOutcome[];
  /** False only when ≥1 piece attempted generation and EVERY attempt failed (skips aren't failures). */
  ok: boolean;
}

/** A comment as it comes off the wire, before ids/reactions/timestamps are assigned in code. */
interface RawComment {
  username: string;
  body: string;
  /** An existing comment id, `new:N` (0-based index into this batch), or null for top-level. */
  replyTo: string | null;
}

/**
 * Run the comments stage over a manifest: for each publishable opinion piece, seed (empty thread) or
 * grow (within the window + under the cap) its comment thread by one generated batch. Never throws;
 * per-piece failures are contained. Returns a COPY of the manifest with the updated `comments[]`
 * arrays (dry-run returns the input untouched).
 */
export async function runComments(
  config: Config,
  startingManifest: Manifest,
  assets: OpinionAssets,
  deps: CommentsDeps,
  opts: CommentsOptions = {},
): Promise<CommentsResult> {
  const log = deps.log ?? (() => {});
  const dryRun = opts.dryRun ?? false;
  const cc = config.comments;

  const manifest: Manifest = dryRun
    ? startingManifest
    : { version: startingManifest.version, stories: { ...startingManifest.stories } };

  const pieces: PieceOutcome[] = [];
  if (!cc.enabled) return { manifest, pieces, ok: true };

  const nowMs = deps.now().getTime();
  const growWindowMs = cc.growWindowHours * 3600_000;

  // Publishable opinion pieces, newest-first so any future per-cycle budget favors fresh threads.
  const candidates = Object.values(manifest.stories)
    .filter((r) => isOpinionRecord(r) && isPublishable(r))
    .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));

  for (const record of candidates) {
    const existing = record.comments ?? [];

    // Decide seed vs grow, and how many to request — bounded by the window + the per-piece cap.
    let mode: "seed" | "grow";
    let count: number;
    if (existing.length === 0) {
      mode = "seed";
      count = cc.initialCount;
    } else {
      const firstSeenMs = new Date(record.firstSeen).getTime();
      const withinWindow = !Number.isFinite(firstSeenMs) || nowMs - firstSeenMs <= growWindowMs;
      if (!withinWindow) {
        pieces.push({ id: record.id, status: "skipped-frozen", added: 0 });
        continue;
      }
      if (existing.length >= cc.maxPerPiece) {
        pieces.push({ id: record.id, status: "skipped-capped", added: 0 });
        continue;
      }
      mode = "grow";
      count = Math.min(cc.perPassCount, cc.maxPerPiece - existing.length);
    }

    if (dryRun) {
      pieces.push({
        id: record.id,
        status: mode === "seed" ? "seeded" : "grew",
        added: 0,
        detail: `would ${mode} ${count}`,
      });
      continue;
    }

    try {
      const hot = hotCommentIds(existing, HOT_TARGETS);
      const deck = buildDeck(record.id, existing.length);
      const prompt = buildCommentsPrompt(assets.comments, record, existing, { count, mode }, hot, deck);
      const text = await deps.generate(prompt);
      if (text == null) {
        pieces.push({ id: record.id, status: "failed", added: 0, detail: "no completion" });
        continue;
      }
      const raw = parseComments(text);
      if (raw.length === 0) {
        pieces.push({ id: record.id, status: "failed", added: 0, detail: "no usable comments" });
        continue;
      }
      // The model may over- or under-produce; accept up to `count`.
      const minted = mintComments(raw.slice(0, count), record, deps.now());
      // Replace with a NEW record object so the input manifest's record is never mutated.
      manifest.stories[record.id] = { ...record, comments: [...existing, ...minted] };
      pieces.push({
        id: record.id,
        status: mode === "seed" ? "seeded" : "grew",
        added: minted.length,
      });
    } catch (err) {
      // Belt-and-braces: parse/mint are pure, but never let one piece break the stage.
      const msg = err instanceof Error ? err.message : String(err);
      pieces.push({ id: record.id, status: "failed", added: 0, detail: msg });
      log(`comments: ${record.id} failed — ${msg}`);
    }
  }

  const attempted = pieces.filter((p) => p.status === "seeded" || p.status === "grew" || p.status === "failed");
  const succeeded = pieces.filter((p) => p.status === "seeded" || p.status === "grew").length;
  const ok = attempted.length === 0 ? true : succeeded > 0;
  return { manifest, pieces, ok };
}

/** A compact one-line summary of the stage outcome, for the cycle's per-stage log (ADR-0018 style). */
export function summarizeComments(result: CommentsResult): string {
  const n = (s: PieceStatus) => result.pieces.filter((p) => p.status === s).length;
  const added = result.pieces.reduce((sum, p) => sum + p.added, 0);
  return (
    `${n("seeded")} seeded, ${n("grew")} grew (+${added}), ` +
    `${n("skipped-frozen")} frozen, ${n("skipped-capped")} capped, ${n("failed")} failed`
  );
}

/**
 * The ids of the `topN` "hottest" existing comments — highest `up + 3·replies + laugh`. Fed to the
 * prompt as reply magnets so busy threads snowball and lonely one-liners stall (a living section,
 * not a flat dump). Pure; deterministic from the stored tallies.
 */
export function hotCommentIds(comments: Comment[], topN: number): Set<string> {
  const replyCount = new Map<string, number>();
  for (const c of comments) {
    if (c.parentId) replyCount.set(c.parentId, (replyCount.get(c.parentId) ?? 0) + 1);
  }
  const scored = comments.map((c) => ({
    id: c.id,
    score: c.reactions.up + 3 * (replyCount.get(c.id) ?? 0) + c.reactions.laugh,
  }));
  scored.sort((a, b) => b.score - a.score);
  return new Set(scored.slice(0, topN).map((s) => s.id));
}

/**
 * Assemble the comment-generation prompt: the shared comments block (register + comedy + guardrails),
 * the per-thread FRESH-ANGLES deck (ADR-0029 — rotating comedy material + the avoid-the-house-gags
 * steer that breaks the formulaic openers), the piece context (headline + excerpt of the actual
 * column, so commenters misread THIS piece), the existing thread as a compact id/username/reply/body
 * list (so replies reference real ids and continue running feuds, with the hot comments flagged), and
 * the task + strict-JSON contract.
 */
export function buildCommentsPrompt(
  commentsBlock: string,
  piece: ManifestRecord,
  existing: Comment[],
  quota: { count: number; mode: "seed" | "grow" },
  hot: Set<string>,
  deck: CommentDeck,
): string {
  const headline = piece.headline ?? piece.title ?? "";
  const body = excerpt(piece.description ?? "", BODY_CONTEXT_CHARS);

  const threadBlock =
    existing.length === 0
      ? "This piece is BRAND NEW — write the FIRST comments. Most should be top-level (replyTo: null); " +
        "a couple may reply to each other using new:N."
      : "EXISTING COMMENTS (reply to any of these ids, or to a new:N comment in your batch, or null " +
        "for a fresh top-level comment). [HOT] marks the comments getting the most attention — pile " +
        "onto those:\n" +
        existing
          .map((c) => {
            const tag = hot.has(c.id) ? "[HOT] " : "";
            const to = c.parentId ? `reply→${c.parentId}` : "top-level";
            return `${tag}${c.id} | ${c.username} | ${to} | ${excerpt(c.body, 120)}`;
          })
          .join("\n");

  const task =
    quota.mode === "seed"
      ? `Write ${quota.count} NEW opening comments for this thread. MOST should react to THIS ` +
        `specific column — misread it, take the wrong side of its actual argument, or start a feud ` +
        `over what it says — using the on-topic moves from the FRESH ANGLES above. Keep ~1 in 3 ` +
        `totally off-topic (use the tangents above). Mix lengths and forms, and invent funny ` +
        `usernames in the dealt style. A couple may reply to each other via new:N.`
      : `Add ${quota.count} NEW comments to this thread. Skew toward REPLIES that continue the ` +
        `existing arguments (attach most to the [HOT] comments), plus a few fresh top-level ones ` +
        `that pull from the FRESH ANGLES above. Keep the ~1-in-3 off-topic quota and invent funny ` +
        `usernames in the dealt style.`;

  return [
    commentsBlock.trim(),
    renderDeck(deck),
    `THE OPINION PIECE PEOPLE ARE COMMENTING ON:\nHEADLINE: ${headline}\nEXCERPT: ${body}`,
    threadBlock,
    task,
    'Output STRICT JSON and nothing else: {"comments":[{"username":"...","body":"...","replyTo":"<id|new:N|null>"}]}.',
  ].join("\n\n");
}

/**
 * Strictly parse a comment batch, defensively (mirrors parseImageBrief): never throws, returns [] on
 * any structural deviation. Drops individual comments that are empty, over-length, or read as a leaked
 * refusal/preamble; REJECTS THE WHOLE BATCH (returns []) if any comment contains a link or trips the
 * violence/hate denylist — fail-closed, since a hard violation must never reach a page and skipping
 * one growth pass is cheap.
 */
export function parseComments(text: string): RawComment[] {
  const slice = extractJsonObject(text);
  if (slice == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const list = (parsed as Record<string, unknown>).comments;
  if (!Array.isArray(list)) return [];

  const out: RawComment[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.username !== "string" || typeof rec.body !== "string") continue;

    const username = rec.username.replace(/\s+/g, " ").trim();
    const body = stripWrappingFence(rec.body).trim();
    if (username.length === 0 || body.length === 0) continue;
    if (username.length > MAX_USERNAME_CHARS || body.length > MAX_COMMENT_BODY_CHARS) continue;
    if (looksLikeRefusal(body) || looksLikeMetaNarration(body)) continue;

    // Hard violations fail the WHOLE batch closed — a link or banned phrase must never post.
    if (
      containsLink(body) ||
      containsLink(username) ||
      hasBannedContent(body) ||
      hasBannedContent(username)
    ) {
      return [];
    }

    let replyTo: string | null = null;
    if (typeof rec.replyTo === "string" && rec.replyTo.trim().length > 0) replyTo = rec.replyTo.trim();
    out.push({ username, body, replyTo });
  }
  return out;
}

/**
 * Assign ids, resolve reply targets, finalize reaction tallies, and stamp timestamps for one accepted
 * batch. Ids are minted append-only from the existing thread length. A `replyTo` is honored only when
 * it resolves to an already-persisted comment id or an EARLIER new comment in this batch (`new:N`,
 * N < index — no forward refs, no cycles); anything else coerces to top-level (null).
 */
export function mintComments(raw: RawComment[], piece: ManifestRecord, now: Date): Comment[] {
  const startIndex = (piece.comments ?? []).length;
  const existingIds = new Set((piece.comments ?? []).map((c) => c.id));
  const newIds = raw.map((_, i) => `${piece.id}-c${startIndex + i}`);
  const createdAt = now.toISOString();

  return raw.map((r, i) => {
    let parentId: string | null = null;
    if (r.replyTo) {
      const m = /^new:(\d+)$/.exec(r.replyTo);
      if (m) {
        const idx = Number(m[1]);
        if (idx < i) parentId = newIds[idx]; // earlier new comment only
      } else if (existingIds.has(r.replyTo)) {
        parentId = r.replyTo;
      }
    }
    return {
      id: newIds[i],
      username: r.username,
      body: r.body,
      parentId,
      reactions: finalizeReactions(newIds[i]),
      createdAt,
    };
  });
}

/**
 * Deterministic, organic-looking reaction tallies from `hashString(id)` (the render's hash), so a
 * few comments hit 200+ thumbs while most sit in single digits — the "212 / 5 / 1" spread of a real
 * section — reproducibly and testably, with no Math.random. Buckets: ~70% get 0–14 up, ~25% get
 * 15–74, ~5% spike 150–269. Laugh usually low with rare spikes; down/flag stay small.
 */
export function finalizeReactions(id: string): Comment["reactions"] {
  const h = hashString(id);
  const bucket = h % 100;
  let up: number;
  if (bucket < 70) up = h % 15;
  else if (bucket < 95) up = 15 + (h % 60);
  else up = 150 + (h % 120);

  const hl = hashString(id + ":laugh");
  const laugh = hl % 100 < 82 ? hl % 6 : 12 + (hl % 55);
  const down = hashString(id + ":down") % 12;
  const hf = hashString(id + ":flag");
  const flag = hf % 100 < 85 ? hf % 4 : 4 + (hf % 8);

  return { up, down, laugh, flag };
}
