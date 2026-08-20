# ADR-0033: Columnist reliability + Opinion-section content safety

## Status

Accepted — 2026-08-20. Part 0, Part 1, and Part 2 (2a/2b/2d/2g) shipped; 2c/2e dropped as no-ops on
investigation (see below); 2f (TTS infra) remaining.

## Context

Two failures surfaced on 2026-08-20.

**Content safety.** 19 real news stories were mis-tagged `category: OPINION` by the news generator
and rendered on the Opinion page as authorless "BY THE OPINION DESK" items, **bypassing the taste
gate** — several named real private individuals in tragedies (e.g. a postpartum-psychosis piece
naming a real person, deadly fires, a fatal police shooting). The Opinion *section* page listed any
`category === "OPINION"` record with no `author` check (the cover already guarded this).

**Reliability.** Only 2 of 4 columns published that morning: the taste gate failed closed (TTS
`413 over_budget` + the Claude fallback gate hung 303s then errored), routing the news personas to
the evergreen fallback — which then *also* failed for two of them because the same degraded backend
returned malformed output. Investigation showed this is chronic, not a one-off: a column must clear a
**~7-step serial chain of fail-closed guardrails** driven by nondeterministic model output with only
`MAX_PIECE_ATTEMPTS = 2`, over **shared single points of failure** — one gate call gates every news
columnist, one flaky TTS service backs the gate + image-brief, and the gate + brief run on the weaker
Haiku model while the columns use Sonnet. Every prior incident (ADR-0023/0026/0031/0032) hardened one
link by adding another fail-closed guard, so *quality* is well defended but *reliably producing the
day's 4 columns* is not. The ADR-0032 "evergreen never-empty" guarantee was **overstated**: evergreen
pieces run the identical failable gauntlet, and Layer D even converted cost-free skips into failable
attempts.

## Decision

### Part 0 — Opinion section lists only authored columns (SHIPPED)

`src/render/index.ts`: the OPINION section filter requires `records[i].author`. Any authorless
OPINION record (mis-tagged news) is excluded from the opinion page and its story count. Immediate
render + redeploy pulled the 19 live leaks. Cover already had the equivalent guard.

### Part 1 — News stories can never be tagged OPINION (SHIPPED)

`OPINION` is reserved for authored columns. `src/category.ts` adds `NEWS_CATEGORIES` (all sections
minus OPINION) and `normalizeNewsCategory` (coerces a stray `OPINION` → `WORLD`); `src/prompt.ts`
offers only `NEWS_CATEGORIES`; the news parse (`src/generator/parse.ts`, `src/generator/tts.ts`) uses
`normalizeNewsCategory`. Defense in depth behind Part 0's render guard. Existing mis-tagged records
need no migration — they are hidden by Part 0 and age out.

### Part 2 — Reliability overhaul (attack the chokepoints)

- **2a. Model-independent last resort (the real never-empty).** When every live attempt for a
  *scheduled* author (news OR letters) fails, publish a committed, hand-written **canned column** for
  that persona (`personas/fallbacks/<name>.md`) using the persona's headshot avatar as the hero image
  — **no model or image-gen call**, so a fully degraded backend cannot leave the section short. Wired
  as the terminal branch replacing the `failed` exit in `runOpinions`. Tagged `fallbackUsed` so it is
  visible, not silent.
- **2b. Soften + widen retry.** Raise `MAX_PIECE_ATTEMPTS` (2 → 4); make the strict length band
  warn-only for no-source evergreen pieces so they don't fail on a guardrail that barely applies.
- **2c. Gate + image-brief on the stronger model. — DROPPED (already the case).** Investigation
  during implementation showed `deps.textGenerator` is built with `config.generator.opinionModel`
  (Sonnet) at `cycle-cli.ts`, and `createTextGenerator` applies that model to *every* call through
  it — so the Claude gate and brief already run on Sonnet, not Haiku. The 2026-08-20 Claude-gate
  failure was a CLI hang/error (303s, exit 1), not model quality. No change needed.
- **2d. Chunk the gate. — SHIPPED.** `GATE_BATCH_SIZE = 25`; the gate classifies candidates in
  independent batches. A failed batch excludes only its own candidates (fail-closed per batch); the
  whole gate fails closed only when every batch fails. Removes the "one oversized/flaky call empties
  Opinion" SPOF and shrinks the per-call size that caused the hang.
- **2e. Fix the Hodge/`OWNED_SECTIONS` interaction. — DROPPED (conflicts with the owner directive).**
  Letting normal personas draw a SPORTS pick when the pool is all-sports would violate "only Hodge
  covers sports." The correct behavior on such a day is that a normal persona has no news in its lane
  and goes to evergreen → and 2a now guarantees it still publishes. No change needed.
- **2f. TTS health. — REMAINING.** Shorten the Claude fallback-gate timeout so it fails fast instead
  of hanging 303s; flag the `text-transform-service` `413 over_budget` cap to the owner (a separate
  service/repo — the chronic root that code can only partly mitigate).
- **2g. Observability + honesty.** Correct the "never-empty" overclaim; per-cycle health line
  "columns: N/target (K canned-fallback)" so degraded days are visible, not hidden behind the count.

## Consequences

- The Opinion section can no longer surface authorless/mis-tagged news — the taste gate is the only
  door into it, and real-name/tragedy leaks are structurally impossible via that page.
- The section reliably produces its scheduled columns even when the whole generation backend is down,
  via a fallback that makes no network/model call. Fallback use is logged, so a degraded backend is
  visible rather than masked by a healthy-looking count.
- Fragility is attacked at the chokepoints (gate model, gate chunking, canned last resort) rather than
  by adding another fail-closed guard.
- Delivered in slices (2a+2b, then 2c+2d, then 2e/2f/2g); lands on `master` directly per the current
  delivery override.
