# ADR-0022: TTS local provider — per-task failover implementation

## Status
Accepted

## Context
ADR-0021 recorded the design for an opt-in, local-first provider backed by `text-transform-
service` (TTS, a LAN LLM at `TTS_URL`, default `http://G434:8712`) and **deferred the code**
until at least one requested transform was registered in the TTS repo. That trigger is now
satisfied: TTS shipped three of the four requested transforms (cycles T9/T10) —
`story-cover`, `opinion-gate`, `opinion-image-brief` — and **HELD `opinion-piece`** (long-form
voiced generation, out of the TTS charter; a product decision, not an executor call). The
binding contract for what each transform accepts and returns is `docs/brickfeed-2026-07-
RESPONSE.md` (copied from the TTS repo, provenance PR #11) plus each transform's module
docstring and the TTS `docs/ai-reference.md`. Where those differ from the original request, the
RESPONSE rules.

HTTP shape: `POST {url}/v1/transform/{name}`, body `{text, options}` → `200 {output, meta}`;
errors `{error:{code,message}}` with a frozen taxonomy (400/401/404/413/422/503/500); keyless
in prod (no `TRANSFORM_API_KEY`). Every routable transform takes `options: {}`.

Phase-1 exploration of the *incumbent code* overturned two premises the kickoff stated:

1. **Image prompts are already neutral.** The incumbent story/brief prompts explicitly forbid
   pre-applied styling (`src/prompt.ts`, `src/opinions.ts:buildImageBriefPrompt`); `wrapBrickStyle`
   is the single downstream styling chokepoint (`src/generate.ts`, `src/opinions.ts` at the
   record-build sites). TTS's transforms are likewise subject-neutral (TTS ADR-0004). So the TTS
   provider must return the image prompt **unwrapped**, identical in kind to the incumbent's
   output — wrapping inside the provider would double-apply the style.
2. **The gate does not fail *over* — it fails *closed*.** `opinion-gate` is a safety classifier
   (TTS ADR-0007). RESPONSE §2 requires the caller to treat every 4xx/5xx, every unreachable, every
   `uncertain` verdict, and any missing/duplicate id as **excluded** — never escalate to another
   model. This is the opposite of the failover posture used for the two non-safety tasks.

## Decision
1. **Per-task opt-in, defaults unchanged.** A new optional `generator.tts` block —
   `{ url, storyCover, opinionGate, opinionImageBrief }` with all flags **false** by default —
   selects which tasks route to TTS. Absent block or all-false → behavior is byte-identical to
   today (`generator.provider` stays `claude`, ADR-0011). `opinion-piece` is **not** a routable
   flag (HELD). `url` is a non-secret endpoint (canonical home: `config.json`); an optional
   `TTS_URL` env override (read via a new **non-secret** `getTtsUrl()` accessor in `src/secrets.ts`,
   the sole `process.env` reader) lets a cron cycle repoint it via `cron.env`.
2. **Client + adapters (`src/generator/tts.ts`, `src/opinions-tts.ts`).** A plain-`fetch`
   `TtsClient` (injectable HTTP boundary, `AbortController` timeout) POSTs a transform and returns
   a typed result; on any non-200, unreachable endpoint, or malformed 200 envelope it emits ONE
   structured warning (`task`, `status`, `code`) and returns a failure. No retries beyond TTS's
   own. Each task adapter returns the SAME type the incumbent produces, image prompts **neutral**.
3. **Failover matrix.**
   - `story-cover` (story `Generator` seam): `TtsFailoverGenerator` tries TTS, returns the
     incumbent's result on any TTS failure. Wired in `createGenerator`, so both the generate and
     cycle CLIs inherit it.
   - `opinion-image-brief`: on any TTS failure the adapter returns `null`, and the **existing**
     incumbent brief call in `runOpinions` runs as the transparent fallback (zero rewrite of the
     incumbent path).
   - `opinion-gate`: **fail-closed.** On a 200, a complete per-id verdict map is built —
     `eligible` only for an `eligible` verdict, everything else (`excluded`, `uncertain`, missing
     id, duplicate id) → `excluded`. On any 4xx/5xx/unreachable → `null`, which the stage treats as
     its existing "gate failed closed → all candidates excluded" path. There is **no** Claude
     fallback for the gate; excluding is the safe outcome.
   A cycle never fails because TTS did: a TTS outage degrades to the incumbent (story/brief) or to
   fail-closed exclusion (gate, which self-heals next cycle).
4. **Tests.** Mocked (no live network): client success/error taxonomy, story-cover mapping +
   failover wiring + neutral-prompt/no-double-wrap parity, the full gate fail-closed matrix
   (eligible / uncertain / missing / duplicate / 4xx / 5xx / unreachable), brief success + failover
   integration through `runOpinions`, and config/env-override validation. One opt-in live test
   (`TTS_LIVE=1`) asserts shape + subject-neutrality against a real TTS; skipped in CI.

## Consequences
- Opt-in only; with no `generator.tts` block the runtime surface is unchanged (`npx tsc --noEmit`
  clean; the pre-existing suite stays green; 54 new tests added).
- Enabling `opinionGate` on TTS trades resilience for the safety contract: if TTS is unavailable
  that cycle, **all** news candidates are excluded (no news-based satire that run; letters
  unaffected), self-healing on the next cycle. This is intentional and documented for the operator.
- **Live-serving status this cycle (Ship + note).** During this cycle the G434 registry was
  redeployed and now lists all three transforms, but the Ollama backend was unreachable
  (`/health` → `degraded`, `ollama_reachable:false`), so every generation returned
  `503 model_unavailable`. Failover was therefore verified **live** against the real 503 (and
  against an unreachable URL) — both degrade to the incumbent. A true green "TTS-serving" cycle
  is pending Ollama being restored on G434; that is TTS/ops work outside this repo's scope fence,
  and the failover design makes the interim safe.
- `opinion-piece` stays on the incumbent Claude provider permanently unless a future ADR + bench
  admit voiced generation to TTS.

## Alternatives considered
- **A single global provider flip instead of per-task flags.** Rejected: the tasks migrate to TTS
  one transform at a time, `opinion-piece` is permanently held, and the gate needs different error
  semantics from the other tasks — per-task opt-in expresses all three cleanly.
- **Apply `wrapBrickStyle` inside the TTS provider (per the kickoff's literal wording).** Rejected:
  the incumbent output is already neutral and `wrapBrickStyle` runs once downstream; wrapping in
  the provider would double-apply the style. The kickoff's intent ("identical received shape") is
  met by returning the neutral prompt unchanged.
- **Fail the gate *over* to Claude on a TTS error (uniform failover).** Rejected: the binding
  RESPONSE §2 safety contract requires fail-closed exclusion for the gate; escalating a safety
  classifier's error to a different model is not the safe default.

## References
- ADR-0021 (deferral + intended design), ADR-0011 (Claude/Haiku incumbent), ADR-0007 (grok-terminal
  images), ADR-0003 (non-secret `local` endpoint precedent).
- `docs/brickfeed-2026-07-RESPONSE.md` (binding TTS disposition), `docs/tts-inventory.md`,
  `docs/tts-transform-requests.md`. TTS-side: its ADR-0004 (caller-side styling), ADR-0007 (safety
  classification exception).
