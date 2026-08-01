# ADR-0027: Daily columnist fixtures (a news persona that publishes every day)

Status: Accepted
Date: 2026-08-01

## Context

The opinion roster's cadence is fixed by ADR-0013 #3: `source: news` personas run on a stateless
3-pair rotation (`ROTATION`, `src/opinions.ts`), active pair = `daysSinceUnixEpoch(UTC) % 3`, so
each news persona publishes **once every three days**. `source: letters` personas self-schedule by
weekday overlay (ADR-0014) and *can* run daily, but they **invent fictional reader letters**
(`personas/_letters.md`) rather than react to real stories.

A new columnist — **Hodge**, a time-displaced medieval serf covering real sports/news events he
watches but does not understand — is defined by a **daily** beat ("he publishes every day; he's a
serf"). Neither existing lane fits: the 3-pair rotation rations him to every third day, and the
letters lane would force him to fabricate letters instead of reacting to real events. Daily cadence
for a *news* persona therefore requires a small, deliberate mechanism, not a config toggle (there is
no per-persona frequency field, by design).

## Decision

Introduce a **daily-fixture lane** alongside the rotation, leaving ADR-0013's pairs intact.

1. **`DAILY_NEWS`** (`src/opinions.ts`) — a list of `source: news` persona names that publish every
   day, **outside** `ROTATION`. Seeded with `["hodge"]`.

2. **`authorsFor` composition** — the day's author set becomes: the rotation pair (as before), then
   the `DAILY_NEWS` fixtures (present in the roster, `source: news`, **deduped** against the day's
   pair), then the scheduled letters overlay. Order: `[...pair, ...daily, ...letters]`. A fixture
   already appearing in a pair is not double-listed (defensive; `hodge` is not in any pair today).

`ROTATION` and its pinned test are untouched; the fixture lane is a separate concern layered on top.

### Rejected alternative

Folding `hodge` into all three `ROTATION` entries (pairs → triples). It needs no `authorsFor` logic
change, but it muddies the documented "fixed pairs" contract, repeats the name three times, and
rewrites the ADR-0013 rotation pin. The fixture lane keeps "rotation" and "daily" as clean, distinct
ideas and is trivially extensible to future daily columnists.

## Consequences

- Each day now publishes 2 rotating news authors + every `DAILY_NEWS` fixture (Hodge) + any
  scheduled letters author. Hodge's columnist archive (ADR-0025) fills ~3× faster than a rotation
  persona's — expected, given a daily beat.
- Adding/removing a daily columnist is a one-line `DAILY_NEWS` edit (plus the persona file + roster
  test pins), not a rotation rewrite.
- `authorsFor` stays pure and deterministic; the new lane is covered by `test/opinions.test.ts`
  (Hodge present across the whole 3-day cycle) and the roster pins in `test/personas.test.ts`
  (nine authors: seven news incl. hodge, two letters).
- No config or schema change: Hodge is an ordinary `source: news` persona (SPORTS-dominant
  `selection_bias`); only membership in the code-level `DAILY_NEWS` grants the daily cadence.

## References

- ADR-0013 #3 (the fixed-pair rotation this augments), #5 (retention)
- ADR-0014 (letters weekday scheduling — why the letters lane didn't fit)
- ADR-0025 (opinion archive retention — columnist pages accumulate the daily output)
