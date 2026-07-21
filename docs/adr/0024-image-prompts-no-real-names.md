# ADR-0024: Image prompts name no real, identifiable people

Status: Accepted
Date: 2026-07-21

## Context

Opinion writer Bob's 2026-07-21 piece published its text on time but never got a hero
image, so it stayed unpublished (the hard guardrail: never publish without an image).
Investigation showed this is **not** a code regression and **not** a storage/credit
problem — Grok generation is healthy. It is a **behavior change in Grok's `/imagine`
skill**: it now refuses to generate a named real person *from scratch* and instead
insists on fetching a reference photo to use `image_edit`. Our image provider runs Grok
headlessly in a sandbox that denies `Bash`/`Shell`/`Terminal` (see
`grokHeadlessArgs` in `src/generator/grokTerminal.ts`), so the reference download is
blocked, Grok gives up asking the operator to upload a photo, and **exits 0 with no image
written**. The provider sees no file → `null` → the story fails to image, every cycle,
forever — no retry (ADR-0023) can manufacture an image Grok refuses to draw.

Reproduced directly: Bob's prompt ("Former mayor Andy Burnham strolls…") fails; a generic
prompt ("a red plastic toy-brick minifigure on a desk") succeeds. A scan of pending
records showed the same latent failure in a POLITICS story naming "JD Vance and Usha".

Two generators can emit a real name into an image prompt:
- **News** — `GENERATION_INSTRUCTIONS` in `src/prompt.ts`, which *explicitly invited* it:
  "A caricature of a well-known public figure is fine."
- **Opinion** — `buildImageBriefPrompt` in `src/opinions.ts`, which neither invited nor
  forbade it, and in practice named the piece's subject.

This also sits crosswise to the ADR-0001 legal guardrails: every image is meant to be our
**own generic art**, never a real person's likeness.

## Decision

Both image-prompt generators must instruct the model to **never name or depict a
specific, identifiable real individual** in the `imagePrompt` scene. People are described
only by a **generic role or appearance** ("a former mayor", "a government official", "a
vice-president"). The prior public-figure allowance is removed from `src/prompt.ts`.

Scope is the `imagePrompt` field only — the visual scene sent to Grok. The `caption`
(display-only editorial text, never sent to an image model) may still name people; that is
normal, legal, original writing.

## Consequences

- Real-person stories image successfully again (generic figures don't trip Grok's guard),
  and images are more clearly our own art (ADR-0001 aligned).
- Enforcement is prompt-side and therefore best-effort: the model can still occasionally
  leak a name. The ADR-0023 opinion retry and the operator re-image path remain the
  backstops; a future deterministic name guard is possible if leakage proves common.
- Records already generated keep their stored prompts — they are re-briefed on their next
  generation, or (operationally) anonymized in place and re-imaged. Today's Bob and the
  JD Vance story were anonymized in the manifest and re-imaged out-of-band to unstick the
  live site immediately.
- Regression anchors added in `test/prompt.test.ts` and `test/opinions.test.ts` assert the
  new rule is present and the old "caricature" allowance is gone.

## References

- ADR-0001 (legal guardrails: our own generic art, no real likenesses)
- ADR-0016 (opinion image brief)
- ADR-0023 (opinion in-cycle recovery — the retry that cannot help here)
- `src/generator/grokTerminal.ts` (headless sandbox denies shell tools by design)
