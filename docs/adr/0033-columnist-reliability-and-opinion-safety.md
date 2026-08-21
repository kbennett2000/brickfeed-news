# ADR-0033: Columnist reliability + Opinion-section content safety

## Status

Accepted — 2026-08-20. Part 0, Part 1, and Part 2 (2a/2b/2d/2g) shipped; 2c/2e dropped as no-ops on
investigation (see below); 2f (TTS infra) shipped. **Part 3 added 2026-08-21** — the REAL root cause
of the chronic "zero columns" mornings turned out to be a publish-hour/suspend collision, not the
TTS/GPU backend everyone had been hardening (see Part 3).

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
- **2f. TTS health. — SHIPPED.** Two halves, both now closed:
  - *Code side (this repo).* `defaultClaudeRunner` (`src/generator/subscription.ts`) was the lone
    text runner with no timeout, so the Claude fallback taste-gate could hang (~303s on 2026-08-20)
    and stall the cycle. It now spawns via `spawnClaude(...)` bounded by `DEFAULT_CLAUDE_TIMEOUT_MS =
    120_000` (matching the grok text runner and the TTS gate budget): a hung child is SIGKILLed and
    resolves `code:1` → `null`, so the gate fails fast to the 2a canned fallback. `ClaudeRunner` gained
    an optional `timeoutMs` (additive) for tuning/testing.
  - *Infra side (separate repos).* The chronic `413 over_budget` / `503 busy` / unreachable root was
    GPU contention between `text-transform-service` (:8712) and `imagegen-service` (:8189) on one GPU.
    Fixed **inside those two services** via a shared `flock` GPU-tenancy lock (each tenant loads its
    model, drains its burst, frees its own VRAM, then hands off). **Brickfeed needed no change** — it
    does no caller-side GPU coordination; it is a plain HTTP consumer that retries and fails over, so
    the service-side lock made no brickfeed code obsolete.
- **2g. Observability + honesty.** Correct the "never-empty" overclaim; per-cycle health line
  "columns: N/target (K canned-fallback)" so degraded days are visible, not hidden behind the count.

### Part 3 — The real root cause: publish hour collided with the dev PC's overnight suspend (SHIPPED 2026-08-21)

After Part 2 shipped, mornings were *still* landing zero fresh columns, and it kept getting blamed on
the TTS/GPU backend. On 2026-08-21 the evidence finally pinned the actual cause — and it was not the
generator at all:

- `opinionPublishHourUTC` was **10** (UTC). The opinion stage runs only on a cron tick whose UTC hour
  is `>= 10` (`beforeOpinionPublishHour`). 10:00 UTC = **04:00 America/Denver**. With cron at `0 */4`
  (local ticks 00/04/08/12/16/20 = UTC 06/10/14/18/22/02), the **first/primary publish tick each day
  is 04:00 local** — precisely when the personal dev PC that hosts the orchestrator is asleep.
- `journalctl --list-boots` showed the boot preceding the incident **ended at 2026-08-21 04:04:55**;
  `cycle.log` froze at 04:05:01 mid-way through Edgar's column with no epilogue line. An idle **suspend
  hard-killed the running cycle** before render/deploy — so no in-process guardrail (not even the 2a
  canned fallback) could fire. This had been recurring most nights.
- Proof it was scheduling, not the pipeline: that same morning the topic gate *passed 114/143*
  candidates, render+deploy succeeded on the 00:00/16:00/20:00 ticks, and the manifest held columns
  generated as recently as the day before (including a working 08:00 makeup tick). The machinery was
  healthy; it was simply aimed at the one hour the machine is reliably off.

**Fix:**
- **Move the publish hour off the sleep window.** `opinionPublishHourUTC: 10 → 14` (config.json and
  config.example.json) → primary publish at **08:00 America/Denver**, when the box is reliably awake.
  Overnight ticks now fall *before* the hour and make zero provider calls; midday/afternoon makeup
  ticks (12:00/16:00/20:00 local) still catch up the same day if 08:00 is ever missed.
- **Stop an idle suspend from killing a live run.** `scripts/cycle.sh` now wraps the cycle in
  `systemd-inhibit --what=idle --mode=block`, so an idle auto-suspend is held off for the duration of
  a run (a deliberate owner shutdown/suspend is unaffected). Degrades to a bare run where
  `systemd-inhibit` is unavailable.

The Part 2 / 2f TTS+GPU work stands (it removed real failure modes), but it was treating a symptom.
Part 3 is the fix for the actual chronic outage.

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
