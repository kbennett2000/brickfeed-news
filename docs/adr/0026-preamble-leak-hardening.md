# ADR-0026: Harden against leaked-preamble opinion headlines

Status: Accepted
Date: 2026-08-01

## Context

On 2026-08-01 (04:14 MDT) an opinion column published with a **leaked assistant preamble as its
headline**: "I'll write one reader-letter column for Priscilla now." That is the model's
conversational lead-in, not a title — it was stored as the piece's `headline` and rendered as the
`<h1>` on the live site.

Opinion pieces are free-form text with a *first-line-is-the-title* contract
(`buildOpinionPrompt`, ADR-0016). `splitTitleBody` (`src/opinions.ts`) takes line 1 as the title,
delegating preamble-stripping to `recoverLeadingTitleRegion` → `isDroppablePreamble`
(`src/sanitize.ts`, the "Wisdom's Moat" defenses). That gate dropped a leading line only when it
matched a known meta-narration opener **AND** (had a colon, e.g. "Here is your column:", **OR**
was too long to be a title, e.g. a leaked task description).

The 2026-08-01 line defeated both escape hatches: it opens with `I'll` (a recognized opener) but
has **no colon** and is **short** (~53 chars / 9 words, under the 120-char / 20-word title
bounds). So it was kept and became the headline. `looksLikeRefusal` correctly did not fire — an
"I'll write…" line is not a refusal. The news JSON path's `MAX_HEADLINE_CHARS` did not help
either: the line is genuinely short. Root cause confirmed: **a short, colon-less, first-person
sentence about producing the piece was a blind spot in the preamble gate.**

A secondary gap surfaced during takedown: `render-cli` cleans stale *section* and *columnist*
pages but **not** stale per-story `s/<id>.html` landing pages — removing a record left its landing
page live until deleted by hand.

## Decision

Two independent, conservative layers plus a takedown-hygiene fix.

1. **Broaden detection so recovery strips the leak** (`src/sanitize.ts`). Add
   `looksLikeMetaNarration(line)`: true only for a line that (a) **ends in `.`/`!`/`?`**, (b)
   opens with a `PREAMBLE_OPENER_RE` token, and (c) names a production verb/noun
   (`META_PRODUCTION_RE`: write/compose/draft/column/piece/letter/…). Fold it into
   `isDroppablePreamble` as a third escape hatch alongside colon / too-long. `recoverLeadingTitleRegion`
   then skips the leaked line (and the following `---`) and recovers the real column title — with
   its existing guard intact (only strip if a valid title+body remains). The **terminal-punctuation
   requirement** is the key discriminator that keeps legitimate short titles: "I'll Be There",
   "Let Me Write You a Letter", "Okay Boomer" open with a stop word but do not end like a sentence,
   so they are never dropped.

2. **Fail-closed backstop** (`src/opinions.ts`). In `splitTitleBody`, after computing the title,
   `if (looksLikeMetaNarration(title)) return null;`. Even if recovery cannot salvage a clean
   title, the preamble is never published — the piece is dropped and the author self-heals on the
   next cycle (ADR-0023). Belt (recover) and suspenders (never ship the leak).

3. **Takedown hygiene** (`src/render/index.ts` + `src/render-cli.ts`). Add `stalePerStoryPages`,
   mirroring `staleColumnistPages`: the writer lists the `s/` dir and deletes any `s/<id>.html`
   whose record is no longer published (age-out, or a manual takedown). So removing a story fully
   removes it, and a bad piece can be pulled cleanly without a manual `rm`.

Scope is deliberately narrow. `PREAMBLE_OPENER_RE`, the title bounds, `isPlausibleTitle`, and
`looksLikeRefusal` are unchanged. The news JSON path (`src/generator/parse.ts`) is out of scope
(structured `headline` field, different failure mode); `looksLikeMetaNarration` is exported so it
*could* be reused there later, but no change is made now.

## Consequences

- The exact 2026-08-01 leak now recovers to the real invented title ("The Dinner Party Question");
  a completion whose only title-position line is a meta sentence fails closed (dropped, not
  published).
- Very low false-positive risk: dropping a real title requires it to open with a preamble token,
  name a production word, AND end in sentence punctuation — a combination real titles avoid.
- Takedowns are now self-cleaning: `npm run render` deletes orphaned `s/<id>.html` pages, so the
  deploy stops serving a removed story with no manual step.
- The broken live piece (`opinion-priscilla-2026-08-01`) was removed operationally on 2026-08-01
  (record deleted from the manifest + published set, re-rendered, redeployed; the piece 404s). Its
  image blob is orphaned but harmless (nothing references it; age-out will not see it).
- New tests: `looksLikeMetaNarration` unit + recovery of the exact leak (sanitize); `splitTitleBody`
  recovery and fail-closed cases (opinions); `stalePerStoryPages` (render).

## References

- ADR-0016 (opinion pipeline / output contract), ADR-0019 (columnist bio pages)
- ADR-0023 (opinion in-cycle recovery / self-heal on next cycle)
- `src/sanitize.ts` module doc (the original "Wisdom's Moat" preamble-leak defenses this extends)
