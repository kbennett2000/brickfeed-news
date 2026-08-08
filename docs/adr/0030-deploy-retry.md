# ADR-0030: Bounded retry on transient deploy failure

## Status
Accepted (resilience amendment to ADR-0006 — the CLI-direct Vercel deploy)

## Context
The cycle's final stage shells out to `vercel --prod --yes` from `site/` (ADR-0006). It is
never-throw and fails closed: a non-zero exit returns `failed`, the cycle exits non-zero, and
the live site is left untouched. That contract is correct, but the stage made **exactly one
attempt**.

On 2026-08-08 the 10:00 UTC cron run generated, imaged, and rendered everything correctly
(4 opinions, 243 publishable → 270 files in `site/`), then `vercel --prod --yes` exited 1 and
the cycle aborted at deploy. Nothing shipped. Re-running the identical command by hand
succeeded immediately — the failure was a **transient Vercel hiccup**, not an auth or content
problem. Because the schedule is every 4 hours, a single blip stranded a fully-rendered site
for hours until the next run re-rendered and re-deployed. This was the second observed
transient deploy failure (the ADR-0029 reseed also needed a manual re-deploy).

## Decision
Add a bounded retry around the deploy subprocess, mirroring the existing TTS-client retry
(`retries` / `backoffMs` + a `delay()` helper, `src/generator/tts.ts`).

- Two new `deploy` config fields: `retries` (extra attempts after the first, default **2** →
  3 total tries) and `backoffMs` (base delay, default **10000**). Backoff is **linear**
  (base, 2×base, …). Both validated in `validateDeploy`; `retries: 0` is a legal opt-out
  (one-shot, the old behavior).
- The retry lives **inside `deploy()`** (`src/deploy.ts`) — the single, unit-testable choke
  point. `scripts/cycle.sh` is unchanged (it only runs `npm run cycle`).
- A **non-zero exit or a thrown runner** is retryable. A clean exit 0 short-circuits and
  returns immediately. After the last attempt, `deploy()` returns `failed` exactly as before,
  with `detail` noting the attempt count so the log shows it was retried, not one-shot.

## Consequences
- A transient Vercel failure no longer strands a rendered site for a full cron interval; the
  common case (one blip) self-heals within the same run after a short backoff.
- Worst case adds ~30s (2 backoffs of 10s + 20s) plus the extra deploy attempts before a
  *genuinely* broken deploy is declared `failed` — an acceptable cost on the failure path only.
- **Unchanged contracts:** the empty/invalid-render GUARD still runs once before the loop (the
  site does not change between attempts); `deploy()` is still never-throw; a final failure is
  still a hard, non-zero-exit cycle failure so monitoring still sees it; `DeployStatus` /
  `DeployResult` shapes are unchanged, so the `cycle.ts` wiring needs no change.
- Code-only; takes effect on the next scheduled cron with no reseed or manual step.
