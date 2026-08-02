# ADR-0029: Comment variety deck — breaking the formulaic openers

Status: Accepted
Date: 2026-08-02

Amends ADR-0028 (parody reader comments).

## Context

ADR-0028 shipped and is live, but every opinion piece opened with the **same five comments**: the
raccoon-meat diet, MoonlightAuntie's lost tabby "near exit 14," a Constitution mis-cite, and the
"finish high school / write it in crayon" reply. Threads only loosened up as they grew.

Two root causes, both confirmed in code:

1. **Every seed prompt is near-identical.** A brand-new piece seeds from an empty thread, so
   `buildCommentsPrompt` produces essentially the same prompt for every piece (only the headline +
   a short excerpt differ). The model converges on the same canonical gags. Threads diverge only on
   **grow** passes, where the existing-thread context finally differs per piece.
2. **The persona handed the model its punchlines.** `personas/_comments.md` named the exact gags —
   "the raccoon-meat diet is a **house favorite**" plus eight recurring characters each with a
   signature bit — as always-on examples, making them attractors the model reached for every time.

The owner asked for more variety and chose: do **both** a code fix and a persona rewrite; **retire**
the most overused regulars; and **raise on-topic engagement** so each specific column drives divergence.

## Decision

1. **A deterministic per-piece "flavor deck"** (`src/comments-flavor.ts`). Big hand-authored banks —
   `OFF_TOPIC_THEMES`, `ARGUMENT_MOVES`, `USERNAME_STYLES`, `SHAPE_EMPHASIS`, `RECURRING_CAST` — from
   which `buildDeck(pieceId, existingLength)` deals a small hand (≈3 off-topic tangents, 2 argument
   moves, 1 username style, 1 shape emphasis, and a recurring-cast cameo gated to ≈1 in 3 threads).
   `dealDeck` indexes each bank by `hashString(`${salt}:${i}`)` with linear-probe de-dupe — the same
   `hashString` doctrine as `finalizeReactions`, so **no `Math.random`/`Date`**. Seeding on
   `${pieceId}:${existingLength}` makes two pieces diverge, keeps any single (piece, length)
   reproducible for tests + stable re-renders, and **rotates the hand every grow pass** (length
   changes). The deck shapes only the PROMPT; it is never persisted, so render stability is untouched.

2. **Inject the deck + an explicit avoid-list into the prompt.** `renderDeck` emits a `FRESH ANGLES
   FOR THIS THREAD` block (raw material to invent AROUND, not copy) followed by `AVOID falling back
   on:` naming the retired gags. This is the lever that stops the model defaulting to the worn bits.

3. **Retire the burned regulars; keep three as occasional callbacks.** `RaccoonProtein_Deb`,
   `MoonlightAuntie`, and `2nd-ID-7682` (all in the owner's screenshot) are removed. `rickp53`,
   `PapawBill_of_9`, and `eagle_screech_1776` remain but appear only when the deck deals a cameo
   (≈1 in 3 threads, ≤1 per thread) — a reward for return readers, never the face leading every thread.

4. **Raise on-topic pull.** `BODY_CONTEXT_CHARS` 600 → 1100 so the model sees enough of the actual
   argument to misread it, and the seed task text now pushes ~2/3 of comments to react to THIS
   column's specific claims, with the dealt off-topic tangents as the ~1/3 seasoning. Because every
   column differs, this diverges threads for free.

5. **Persona rewrite** (`personas/_comments.md`). Removes the "house favorite" framing and the
   one-gag-per-character menu; adds a "most comments are about THIS column" section, a "fresh angles
   are dealt to you" section, and the retired-gags avoid-list; demotes the cast to occasional callbacks.

## Consequences

- **No new config.** Deck sizes are code constants; the `comments.*` block is unchanged. `enabled:
  false` remains byte-identical to before.
- **The fix flows forward, not backward.** The ~37 already-seeded pieces keep their baked openers
  (seed fires only on an empty thread). Variety takes effect on (a) all new pieces and (b) grow passes
  on in-window pieces, which now pull rotating deck angles. An optional one-time reseed of in-window
  pieces can refresh existing pages immediately if desired.
- **Guardrails intact.** `parseComments` link/banned/refusal screens are unchanged; every deck entry
  is authored inside the ADR-0028 HARD RULES (no real people, no links/brands, PG-13).
- Coverage added in `test/comments.test.ts`: `dealDeck` determinism + distinctness + cross-piece
  divergence, `buildDeck` rotation across lengths + cameo gate, and `buildCommentsPrompt` carrying the
  FRESH ANGLES + AVOID block. Existing prompt tests updated for the new `deck` parameter.

## References

- ADR-0028 (parody reader comments — this amends it), ADR-0024 (image prompts no real names — the
  same no-real-people posture), ADR-0025 (retain-long / cap-what's-live), the `hashString` deterministic
  distribution reused from `finalizeReactions`.
