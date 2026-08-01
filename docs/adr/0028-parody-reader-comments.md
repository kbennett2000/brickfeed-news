# ADR-0028: Parody reader comments on opinion pieces

Status: Accepted
Date: 2026-08-01

## Context

Opinion pieces (ADR-0013 through ADR-0027) publish as static per-piece pages (`s/<id>.html`) and then
sit unchanged until age-out. The owner wants a **parody comment section** under each opinion piece: a
satire of the overconfident, off-topic, misspelled, Constitution-mangling news-site comment thread.
The explicit #1 goal is that it be **funny** — the more unhinged-but-harmless, the better — so readers
keep coming back. Each piece should publish with a few comments, and every cycle (6×/day) should add
more comments **and replies to comments**, so threads visibly grow.

Constraints from the existing architecture:

- The site is a **static build** with no server or database, so comments must be **generated at build
  time and baked into the pre-rendered HTML**, and their growth must be **persisted** (a seed + clock
  derivation would re-randomize every one of the 6 daily renders).
- Comments must **die with their piece** at age-out, without adding a second retention gate — the
  `ageout.ts` doc comment warns that an unbranched parallel sweep is self-masking.
- Content must satisfy the project's legal/guardrail posture: original, no real people targeted, no
  brands. The comment-section genre invites cruelty, so the guardrail must be explicit and enforced.

## Decision

1. **Inline storage on the opinion record.** A new optional `comments?: Comment[]` on `ManifestRecord`
   (`src/types.ts`), append-only. This inherits age-out for free (the record's deletion drops its
   comments atomically, in the same `writeManifest`), with no separate store and no second retention
   gate. `Comment` = `{ id, username, body, parentId, reactions{up,down,laugh,flag}, createdAt }`.

2. **A new `comments` cycle stage, after `ageout`, before `render`** (`src/comments.ts`, `runComments`).
   It is NOT folded into the opinions stage: opinions is publish-hour-gated and iterates only the day's
   authors, whereas comments must grow **every** live opinion piece on **every** cycle. Placement:
   after `opinions`+`image` a fresh piece is publishable (so it **seeds comments the same cycle it
   debuts**); after `ageout` we never seed a piece that just aged out; before `render` the additions
   flow straight into the pre-rendered page. Per-piece seed vs. grow, bounded by a **grow window**
   (`comments.growWindowHours` — old threads freeze but stay retained, mirroring ADR-0025's "retain
   long, cap what's live") and a **per-piece cap** (`comments.maxPerPiece`).

3. **Generation via the existing text seam, on the stronger model.** One strict-JSON call per piece
   per pass through `TextGenerator`, pinned to `comments.model` (**Sonnet**, a second generator wired
   in `cycle-cli.ts` beside the opinion one) — the story model (Haiku) follows the variety/off-topic
   quotas, JSON schema, and guardrails poorly, exactly as it did for opinion pieces. The prompt layers
   a hand-authored, versioned **`personas/_comments.md`** (register + comedy direction + username
   recipe + a small recurring cast + the hard guardrails) over the piece context and the existing
   thread (so replies reference real commenters and continue running feuds).

4. **Never trust the model for structure or numbers.** Comment ids are minted in code
   (`${pieceId}-c${n}`, append-only counter); the model only references comments by the ids we hand it,
   and unknown/forward refs coerce to top-level. Reaction tallies are finalized **deterministically**
   from `hashString(id)` into a long-tail distribution (the organic "212 / 5 / 1" spread) — the model's
   numbers are discarded (they cluster on round numbers). This keeps re-renders stable and testable
   with no `Math.random`.

5. **Fail-closed guardrails.** `parseComments` mirrors `parseImageBrief` (defensive, never throws, `[]`
   on any deviation): it drops comments that read as a leaked refusal/preamble (reusing `src/sanitize.ts`)
   and **rejects the whole batch** if any comment contains a link or trips a small violence/hate
   denylist (`containsLink` / `hasBannedContent`, new in `sanitize.ts`). Any failure appends nothing;
   the thread self-heals next of the 6 daily cycles. The whole stage is wrapped by the cycle so a
   comment problem can never break the news cycle (same posture as opinions).

6. **Render is a pure presentation of stored state.** `buildCommentTree` (`src/render/index.ts`)
   reduces the flat array into a nested tree (top-level newest-first, replies chronological, display
   depth capped so a pathological chain can't blow up the page); `commentThread` (`src/render/templates.ts`)
   emits a threaded `<ol>`/`<li>` with static reaction numbers under a versioned `COMMENTS_DISCLOSURE`,
   injected into `renderLandingPage` guarded by `view.opinion`. Every model-derived string is escaped;
   cards, cover, and section pages are byte-identical.

### Rejected alternative

A separate `data/comments.json` keyed by opinion id. It keeps the manifest lean, but requires a new
pruning hook reconciled against the manifest on age-out — a second retention gate the codebase
explicitly warns against — and a cross-file consistency window. Inline storage makes age-out and
atomicity free; the size cost is negligible next to the 1200–2500-word opinion bodies already stored
inline in `description`.

## Consequences

- The manifest grows by a few KB per live opinion piece; growth is triple-bounded (grow window,
  per-piece cap, ~90-day retention that eventually deletes everything).
- Comment volume is a Sonnet call per publishable opinion piece per cycle (~a dozen/day). The runtime
  is the keyless subscription CLI, so the cost is latency, not dollars.
- New config block `comments` (`enabled`/`initialCount`/`perPassCount`/`maxPerPiece`/`growWindowHours`/
  `model`), fully defaulted and ON by default; `enabled: false` is byte-identical to before. Documented
  in `docs/CONFIGURATION.md`; example in `config.example.json`.
- `OpinionAssets` gains a `comments` block (`_comments.md`), load-bearing like `_shared.md`/`_letters.md`
  (a missing file throws). Roster pin in `test/personas.test.ts` updated to expect three `_` blocks.
- New stage appears in the cycle stage list and dry-run summary; `test/cycle.test.ts` stage-order pins
  updated. Coverage in `test/comments.test.ts` (prompt, fail-closed parse, seed/grow/cap/freeze,
  per-piece failure isolation, deterministic reactions, tree/depth-cap) and `test/render.test.ts`
  (threaded render + escaping).

## References

- ADR-0013 (opinion architecture; #5 retention this reuses), ADR-0015/0016 (opinion generation +
  the `parseImageBrief` strict-JSON pattern this mirrors), ADR-0023 (in-cycle recovery / fail-closed
  posture), ADR-0025 (retain-long / cap-what's-live precedent), ADR-0026 (sanitize.ts preamble
  hardening this reuses).
