# ADR-0021: TTS local provider — failover posture and deferral

## Status
Accepted

## Context
We want an opt-in **local-first** option for the generation tasks Brickfeed routes through
Claude/Haiku (ADR-0011), backed by `text-transform-service` (TTS) — a LAN LLM service at
`TTS_URL` (default `http://G434:8712`, qwen3.5:9b). The intent: a TTS outage must never fail a
cycle, so every TTS call fails over to the incumbent provider, and the default behavior stays
byte-for-byte the status quo.

Phase 1 exploration (recorded in `docs/tts-inventory.md`) found that Brickfeed routes **four**
distinct tasks through Claude: the bundled story cover call (headline+description+imagePrompt+
category+caption) and three opinion calls (topic-gate, opinion piece, image brief). It also
found that the live TTS registry — `cast-canonicalize`, `cast-mentions`, `illustration-prompt`,
`scene-update`, `image-prompt` — is dominated by transforms for a *different* consuming app;
only `image-prompt` (`text → {prompt}`) is generic.

The kickoff assumed `image-prompt` would cover Brickfeed's image-prompt task. It does not:
Brickfeed never issues a standalone image-prompt call — image prompts are always sub-fields of
a bundled structured call (`src/prompt.ts:16`, `src/opinions.ts:358`). Binding `image-prompt` to
any Brickfeed task would require decomposing a bundled call (a prompt rewrite the scope fence
forbids) or bodging a mismatched schema. **All four tasks are therefore GAPs; nothing can route
to TTS today.** New transforms are authored in the TTS repo, not here.

## Decision
1. **Failover posture (failover, not fallback-chaining).** TTS is opt-in per task. Any non-200
   TTS response (or unreachable endpoint) logs one structured warning (task, status, error code)
   and transparently invokes the incumbent provider. No retries beyond what TTS does internally.
   A cycle produces identical-shaped output whether TTS succeeded, failed over, or was
   unreachable. A TTS outage never fails a cycle.
2. **Default unchanged.** `generator.provider` stays `claude` (ADR-0011); images stay on keyless
   `grok-terminal` (ADR-0007). With no new env var and no config change, behavior is
   byte-for-byte the status quo.
3. **Config seam (intended shape, when code lands).** `TTS_URL` is a non-secret endpoint (like
   `image.local.url`, ADR-0003), so its canonical home is `config.json` under a nested provider
   block, with an optional `TTS_URL` env override read via a new **non-secret** accessor in
   `src/secrets.ts` (the sole sanctioned `process.env` reader) so cron cycles reach it via
   `cron.env` (sourced by `scripts/cycle.sh`). Provider selection follows the existing
   `*_PROVIDERS` tuple + `DEFAULT_*` + validator + factory-switch convention (`src/config.ts`,
   `src/generator/index.ts`). Opt-in is **per task** (not a single global provider flip), because
   the tasks will migrate to TTS one transform at a time as each is authored.
4. **Deferral.** Because all four current tasks are GAPs, provider code is **deferred**. This
   cycle ships only: the Phase-1 inventory (`docs/tts-inventory.md`), the four transform requests
   (`docs/tts-transform-requests.md`), and this ADR. The provider class, config keys,
   `secrets.ts`/`cron.env` wiring, factory branches, and tests land in a follow-up cycle, keyed
   off the transform-requests doc, once **at least one** requested transform is registered in the
   TTS repo. Each task stays on the incumbent Claude provider until its transform exists.

## Consequences
- No runtime surface changes this cycle: `npx tsc --noEmit` and `npm test` stay green; no deploy.
- The transform-requests doc is the contract handed to the TTS repo; the follow-up Brickfeed
  cycle is unblocked the moment any one transform lands (it can wire that single task first).
- The `image-prompt` transform is explicitly **not** reused for any Brickfeed task — its `{prompt}`
  output matches none of the four required schemas.
- The failover design means a partially-migrated system is safe: a task on TTS silently reverts
  to Claude on any TTS error, so enabling TTS per task carries no cycle-failure risk.

## Alternatives considered
- **Build the full provider plumbing now (ready-to-flip).** Rejected: with zero matching
  transforms, the provider would route nothing, could not be integration-tested end-to-end
  against a real task, and the "TTS enabled" cycle demo would be vacuous. Speculative surface
  with no current payoff; deferring until a transform exists is cheaper and honest.
- **Reuse `image-prompt` for the image-prompt sub-tasks.** Rejected: Brickfeed has no standalone
  image-prompt call; the sub-task is bundled with four other fields (task 1) or paired with a
  caption (task 4). Binding it would require decomposing bundled calls (a prompt rewrite, out of
  scope) or bodging a mismatched schema — both forbidden by the kickoff scope fence.
- **Put `TTS_URL` in `src/secrets.ts` as a secret.** Rejected: `TTS_URL` is a non-secret LAN
  endpoint; the repo convention keeps such endpoints in `config.json` (per ADR-0003 `local`
  provider) and reserves `secrets.ts` for tokens. A non-secret env *override* accessor is the
  compromise so cron can point at a different host without editing `config.json`.

## Amendment (2026-07-14): per-task timeout override

The TTS client (implemented per ADR-0022) applied a single hard 30 s wall-clock budget to every
call. That is correct for `story-cover` and `opinion-image-brief` (fast, and they fail *over* to
Claude), but it blocks `opinion-gate`: the gate runs one **constrained batch classification over
the whole candidate set** (~34 verdicts) on the LAN 9B, which inherently takes **~42 s**. Because
the gate fails **closed** (no Claude fallback — excluding is the safe outcome), a 30 s abort
excludes *every* news-opinion candidate that cycle. Verification at real volume confirmed the gate
otherwise returns safe, id-set-equal verdicts; latency was the only blocker.

**Decision.** Give the TTS client a **per-task timeout**. Code defaults: the shared **30 s** stays
for every task, except **`opinion-gate` → 120 s**. An optional `generator.tts.timeoutMs` map (each
key a routable task, each value a positive-integer ms budget) overrides the code default per task;
absent, behavior is byte-identical to before for story-cover/brief. The budget is resolved in
`TtsClient.run(task)` and threaded to the runner's `AbortController`; the **fail-closed posture is
unchanged** — a genuine timeout still aborts to the excluded-all outcome. This moves the *budget*,
not the safety behavior.

**Why not speed up TTS instead.** ~42 s is inherent to a 34-verdict constrained batch on the 9B.
The TTS-side levers are a **model downgrade** (unacceptable on a *safety* classifier) or **chunking**
the batch (more round-trips, no net wall-clock saving, and it splits the gate's global view of the
candidate set). A scheduled cron cycle blocking ~42 s **once** per run is acceptable by design, so
the budget change is the right lever. (This realizes the seam described in ADR-0022.)
