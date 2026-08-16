# ADR-0031: Letter columns must reproduce the reader's letter

## Status

Accepted — 2026-08-16.

## Context

Priscilla's 2026-08-16 column published live malformed. The visible symptom was the headline
("Wanda from Flagstaff, Arizona" — the invented letter-writer's attribution, used as the title). The
**real** defect was worse: the column had **no reader letter at all**. It opened straight on
Priscilla's response ("A lovely question, Wanda. It reminds me of…") and only *paraphrased* the
question inline ("You wrote in asking whether…"). The reader never saw Wanda ask anything.

Reader-letter personas (Priscilla, Tom; `source: letters`, ADR-0014) are supposed to reproduce the
invented letter first — `Dear <columnist>,` / the question in the writer's voice / a
`— <FirstName>, <City>, <State>` sign-off — and *then* answer it. Two things pushed Haiku off that
contract:

1. `personas/_letters.md` said only "open with the letter intro… then answer" — vague about whether
   the letter is reproduced in full.
2. Each letter persona's own comedy engine demonstrates opening with a warm sentence
   ("A lovely question, Megan. It reminds me of…") — which is actually the start of the *answer*.
   The model sometimes collapsed the two, emitting the answer opener as the whole opening and
   dropping the letter.

When the letter is dropped, the model also tends to title the piece with the writer's attribution,
which is how the symptom showed up. Review of history found this had happened silently before
(2026-08-02, -04, -08): all opened "A lovely question, …" with no letter.

## Decision

Make the reader's letter mandatory and enforce it, in three layers:

1. **Prompt (primary).** `personas/_letters.md` now specifies a REQUIRED two-part structure: the
   letter reproduced in full first (salutation → question in the reader's voice → sign-off), then
   the answer — and states explicitly that the warm opener is the start of the answer, never a
   replacement for the letter. A piece that opens on the answer with no `Dear <you>,` above it is
   declared malformed.

2. **Letter-presence guard (backstop).** `letterColumnHasLetter(body, displayName)` in
   `src/sanitize.ts` checks the body's leading region for a salutation addressed to the columnist
   (`Dear Priscilla,` / `Dear Tom,`). The opinion loop applies it for letter personas only; a miss
   returns the piece to the retry path, which **re-rolls the author in-cycle**
   (`MAX_PIECE_ATTEMPTS`) — the same self-healing mechanism as the preamble-leak recovery
   (ADR-0026). This is the guarantee: a letter column with no letter never publishes.

3. **Attribution-title guard (secondary).** `looksLikeLetterAttribution()` rejects a title that is
   just a `<FirstName> from <City>, <State>` attribution, anchored on a real US-state tail so a
   legitimate title containing "from" or a comma is never flagged. Letter-column gated. This catches
   the residual symptom cheaply even if a future failure mode leaks only the title.

## Consequences

- A letter column that omits the letter fails closed and re-rolls the same cycle; it never
  publishes. Worst case (never recovers) mirrors any other exhausted author — that day's column is
  skipped, not published broken.
- The guard keys on the columnist's `displayName`, so it generalizes to any future letter persona
  whose format is `Dear <name>,`. An empty display name disables the check (never fails closed on
  missing config).
- Test fixtures for letter personas now produce letter-shaped bodies (a `pieceFor(prompt, n)` helper
  in the opinion/cycle/TTS suites), matching real output.
- The live 2026-08-16 column was corrected in place — Wanda's letter restored above the response and
  the headline set to "Do Not Split the Nachos" — then re-rendered and re-published.
