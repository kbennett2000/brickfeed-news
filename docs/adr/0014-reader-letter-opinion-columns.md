# ADR-0014: Reader-letter opinion columns

## Status

Accepted

## Context

ADR-0013 established the Opinion section: fictional, clearly-disclosed AI personas
react to selected news articles, two pieces per day from a rotating pair. That gives
every opinion piece the same shape — a persona reacting to the wire.

A second content source widens the section without touching the news pipeline: advice
and explainer columnists who respond to reader letters. No real letters exist and none
are wanted — the letters are as fictional as the columnists, invented by the persona in
the same generation that answers them. Two launch columnists: Tom (consumer-tech
explainer) and Priscilla (dating/life/love advice).

This ADR covers the assets, schema, and bench support. Generation-pipeline wiring,
rendering, and cron scheduling land in later cycles.

## Decision

1. **Personas carry a required `source` field: `news` | `letters`.** `news` personas
   react to selected articles (the ADR-0013 shape). `letters` personas invent a
   fictional reader letter and answer it. A letter piece is ONE completion: the persona
   invents the letter and responds in the same generation — there is no separate
   letter-generation step, no letter store, and no letter reuse.

2. **The front-matter schema branches on `source`.** `news` requires a non-empty
   `selection_bias` and forbids `schedule`/`column_title`. `letters` requires
   `schedule` (a slash-separated list of lowercase UTC weekday tokens, `mon`..`sun`,
   validated strictly, no duplicates) and `column_title`, and forbids
   `selection_bias`. Violations fail loud in the strict parser (`src/personas.ts`),
   exactly like a typo'd bias section.

3. **Letter personas post on a schedule, as an overlay on the rotation.** They post IN
   ADDITION to the daily rotation pair (ADR-0013 decision 3) — an overlay, not a fourth
   pair; the `daysSinceUnixEpoch % 3` rotation is untouched. Tom posts mon/wed/fri/sun;
   Priscilla posts tue/thu/sat/sun. The Sunday double is intentional. Idempotency keys
   are unchanged — `opinion-{author}-{date}` (ADR-0013 decision 4) covers the overlay,
   since no persona ever posts twice in one UTC day.

4. **Column branding, not new sections.** Letter pieces render inside the Opinion
   section — no new nav sections — with the persona's `column_title` on the piece
   (e.g. "Tom's Tech Corner").

5. **Letter-invention guardrails live in `personas/_letters.md`** and are part of this
   contract. The block is prepended after `_shared.md` for `source: letters` personas
   only, and replaces the shared "react only to the source articles" rule with the
   invented letter; all other shared rules stand. In summary (the file is
   authoritative): exactly one letter-writer, common first name + real US city/state,
   never a last name or a real/identifiable person or public figure; the question is
   everyday and PG, names no third parties, confesses nothing illegal, describes no
   identifiable real events; the piece opens with the letter intro in the column's
   format, then answers in the persona's voice; interpretations may be unhinged but no
   real-world facts are invented.

6. **Disclosure: letter columns get one additional static footer line** — hand-written,
   versioned, never model-generated — recording that the letters themselves are
   fictional. The copy (human-owned, edit freely):

   > Reader letters are as fictional as the columnists. Linda does not exist. No one
   > is writing to Tom.

   Wiring happens in the render cycle; this ADR records the copy.

7. **Launch batch is all eight personas** (six news + Tom + Priscilla). Retention:
   letter pieces are OPINION-category records, so `opinionMaxAgeHours` applies with no
   code change (ADR-0013 decision 5).

## Consequences

- `src/personas.ts` gains `source`, `schedule`, and `columnTitle`; the six existing
  persona files gain a one-line `source: news` and are otherwise untouched (their
  bodies are human-edited voice copy).
- The persona bench (`scripts/persona-bench.ts`) gains a letter mode: letter personas
  ignore `--fixtures`/`--recent` and run without article inputs; `--all` runs the six
  news personas over the fixtures plus the two letter personas in letter mode.
- Headshots need no code change: the roster is derived from `personas/*.md`, so the
  next `npm run headshots` processes exactly tom + priscilla.
- The future opinion pipeline stage must branch on `source` when assembling prompts
  (articles vs `_letters.md`) and must add the schedule-overlay publish step alongside
  the rotation pair.

## Alternatives considered

- **Real reader letters.** Rejected: a submission channel means moderation, PII, and
  consent handling on a hobby site; fictional letters keep the legal surface at zero
  and are the funnier bit anyway.
- **A separate letter-generation step (generate letter, then answer it).** Rejected:
  two completions per piece for no quality gain; a stored letter invites reuse and
  drift. One completion keeps the letter disposable and the pipeline stateless.
- **A new "Advice" nav section.** Rejected: the Opinion section already exists and is
  conditionally rendered; column branding on the piece gives the columnists identity
  without another section to keep filled.
- **Folding letter personas into the rotation pairs.** Rejected: the rotation is a
  stateless `% 3` over fixed pairs; inserting scheduled personas into it would either
  break its statelessness or starve the news personas. An overlay leaves both simple.
