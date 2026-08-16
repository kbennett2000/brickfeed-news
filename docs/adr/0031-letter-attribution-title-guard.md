# ADR-0031: Reject a letter-writer attribution used as a column title

## Status

Accepted — 2026-08-16.

## Context

The 2026-08-16 Priscilla column published live with the headline **"Wanda from Flagstaff,
Arizona"** — the invented letter-writer's name and city, not a column title. The body was correct
and on-brand ("A lovely question, Wanda. It reminds me of the autumn of 2004…"); only the title
line was wrong.

Reader-letter personas (Priscilla, Tom; `source: letters`, ADR-0014) are told to open the piece
with the invented letter's attribution in their column format ("<FirstName> from <City>, <State>",
per `personas/_letters.md`). Haiku intermittently emits that attribution as the *first line* — which
the output contract treats as the title (`splitTitleBody`, first line = headline, rest = body).

None of the existing preamble/refusal/meta-narration guards (ADR-0026, `src/sanitize.ts`) catch it:
an attribution is short, clean, colon-less, and not a production sentence, so it looks exactly like a
legitimate short title. Every prior Priscilla/Tom headline was a real title ("Do Not Feed the
Falconers", "Love's Fine Print"); this is the first attribution leak.

## Decision

Add a **letter-column-only** title guard, `looksLikeLetterAttribution` in `src/sanitize.ts`, and
call it from `splitTitleBody` when the persona is a letter column
(`splitTitleBody(piece, persona.source === "letters")`). A hit returns `null`, which the opinion
loop already treats as a transient failure and **re-rolls the author in-cycle** (up to
`MAX_PIECE_ATTEMPTS`) — the model produces a proper title on the next attempt, exactly like the
existing preamble-leak recovery.

The detector is anchored on the US-state tail to stay conservative: it matches a single-word
capitalized first name, `" from "`, a city, and a **real US state** (50 + DC). A legitimate title
that merely contains "from" or a trailing comma ("A Word About Boundaries", "Notes from a Small
Town", "On Pet Names, and the Man Who Trademarked Mine") does not end in a state name and is never
flagged. The gate is off for news personas, so their titles are untouched.

As a second, upstream reduction, the letter-column prompt now states explicitly that the title is a
real column title about the topic and **never** the letter-writer's name and city.

## Consequences

- A leaked attribution title fails closed and self-heals in the same cycle; it never publishes.
- Worst case (both attempts leak) mirrors any other exhausted author: that day's letter column is
  skipped, not published broken.
- False-positive risk is negligible (a real title would have to be literally "<Name> from <City>,
  <State>"); if one ever occurred it would cost a single harmless re-roll.
- The live 2026-08-16 column was corrected in place (headline → "Do Not Split the Nachos") and
  re-published; the guard prevents recurrence.
