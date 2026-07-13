# ADR-0018: Opinion operations — publish-hour gate, health signal, runbook

## Status

Accepted

## Context

The Opinion section runs end to end inside the hourly cycle (ADR-0013…0016), with two
operational gaps left:

- **Pieces publish at the wrong local time.** A day's pieces are keyed to the UTC date,
  so they publish in the first cycle after 00:00 UTC — around 6 PM Denver the previous
  evening. Letter-column weekday labels ("Tom's Tech Corner", posted mon/wed/fri/sun)
  therefore read wrong to local readers, and the morning-column ritual lands at dinner
  time.
- **Persistent failure degrades invisibly.** The stage is deliberately tolerant — an
  opinion problem must never break the news cycle — so a broken provider, a topic gate
  failing closed every run, or a schema regression just produces quiet "0 published"
  summaries until retention empties the section and the empty-section rule hides the
  page. Nothing distinguishes "healthy but idempotent" from "silently dying".

This ADR closes the Opinion infrastructure phase: a publish-hour gate, a structured
health signal with a staleness alarm, and the operator runbook.

(The cycle instruction that requested this work labeled it ADR-0017; that number was
already taken by the ad-rotator ADR, so this is 0018.)

## Decision

1. **The cycle's opinions stage runs only when `getUTCHours() >= opinionPublishHourUTC`**
   (default **13** ≈ 7 AM Denver). The gate is `>=`, never `==` — a missed 13:00 cron
   tick self-heals at 14:00. A gated cycle makes **zero provider calls** (the topic-gate
   classifier must not burn before the publish hour) and reports the distinct stage
   summary `skipped — before publish hour (12 < 13 UTC)`. Rationale: the morning-column
   ritual, and weekday labels that align with reader-local reality.

2. **Direct CLI runs (`npm run opinions`) bypass the gate by construction.** The gate
   lives in the cycle stage (`src/cycle.ts`), not in `runOpinions` — manual is
   deliberate, and the zero-call guarantee is structural rather than a flag someone can
   forget.

3. **New config key `opinionPublishHourUTC`** — integer **0–23**, default **13** when
   absent, anything else fails loud at config load (the same strict pattern as
   `opinionMaxAgeHours`: absence is a default, presence must be valid).

4. **The stage reports a structured outcome plus a gate-summarized one-line summary.**
   `OpinionsResult` gains `gateSummary` (one line describing the topic-gate outcome);
   the cycle logs `{status: "ran" | "skipped-hour", published[], skippedIdempotent[],
   failed[], gateSummary}` as one JSON line, and the stage's summary line becomes
   `N published, N skipped, N failed; <gateSummary>` — same shape and place as every
   other stage's line. Authors skipped for lack of candidates appear in no array by
   design; the gate summary is what explains them.

5. **A staleness alarm runs EVERY cycle** — skipped-hour and all-idempotent cycles
   included. If the newest OPINION record is older than **36 hours**, or there are no
   OPINION records at all, the cycle logs an error-level line carrying the grep token
   **`OPINION-STALE`** plus the age and last-known key. Rationale for the invariant:
   the letters schedules cover all seven days (Tom mon/wed/fri/sun, Priscilla
   tue/thu/sat/sun) and the topic gate never applies to letters, so ≥1 piece/day is
   the healthy floor even on an all-tragedy news day — a newest-piece age past 36h is
   a fault, not weather. The threshold is a code constant, not config: it encodes the
   schedule invariant, not an operator preference. No alert/notify seam exists in this
   repo, so the loud greppable log line IS the deliverable; alerting beyond logs is
   recorded in HANDOFF as future work.

6. **`docs/opinion-runbook.md` is the operator surface** for the section: personas
   (add / punch up / retire), disclosure copy locations, the two knobs
   (`opinionMaxAgeHours`, `opinionPublishHourUTC`), OPINION-STALE triage, and
   `npm run opinions -- --authors all` as the re-launch tool.

## Consequences

- Opinion pieces now appear in the first cycle at/after 13:00 UTC; before that hour the
  stage line reads `skipped — before publish hour (… < 13 UTC)` and the day's news
  pipeline is otherwise untouched.
- A cycle before the publish hour spends nothing on the classifier; the day's single
  gate call happens at most once, in the first open-hour cycle.
- `grep OPINION-STALE cycle.log` is the health check; a silent-death regression now has
  a name within 36 hours instead of a week of quiet emptiness.
- The staleness check runs after the pipeline (post-opinions/ageout), so a recovery
  cycle clears the alarm the same run it publishes.
- Dry-run cycles print the gate decision (`would skip — before publish hour …`) and run
  the staleness check too, so an operator can see both without spending anything.

## Alternatives considered

- **Gate inside `runOpinions` via an option.** Rejected: the CLI bypass and the
  zero-provider-call guarantee should be structural (the gated path never reaches the
  code that could call a provider), not a default-valued flag every caller must get
  right.
- **`==` hour equality instead of `>=`.** Rejected: a single missed or slow 13:00 tick
  would skip the whole day; `>=` self-heals at the next cycle.
- **A config key for the 36h staleness threshold.** Rejected: nothing operator-tunable
  about it — it derives from the seven-day letters schedule invariant; a constant plus
  this ADR records the reasoning.
- **A notify/webhook seam for the alarm.** Deferred: no such seam exists anywhere in
  the repo, and cron already captures stdout into a log the operator greps. Recorded in
  HANDOFF as the natural next step if logs prove too quiet.
