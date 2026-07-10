# Handoff

## Current state
Slice 1 (RSS ingestion) is merged to `master`. **Slice 2 (Claude generation layer)**
is built on branch `slice-2-claude-generation` with an open PR (see issue #3).

Ingestion backbone (Slice 1, merged):
- `src/config.ts` — file-based config (`config.json`, git-ignored; `config.example.json` committed).
- `src/rss.ts` — `fetchFeed` / `parseFeed` (fast-xml-parser). Per-item `<source>` → `sourceName`. Tolerant.
- `src/resolve.ts` — `resolveUrl`: HTTP-follow redirect resolution with a defensive fallback to the wrapped link.
- `src/id.ts` — `normalizeUrl` + `storyId` (sha256 of resolved URL).
- `src/manifest.ts` — atomic read/write of the text-only JSON manifest; missing/corrupt → empty.
- `src/ingest.ts` / `src/index.ts` — pure orchestrator + CLI (`npm run ingest`).

Generation layer (Slice 2):
- `src/types.ts` — `ManifestRecord` extended with optional `headline`/`description`/`imagePrompt`/`wrappedPrompt`; added `GeneratorOutput`, `GenerationInput`, `Generator`, `ClaudeRunner`, `GenerateDeps`.
- `src/secrets.ts` — the ONLY env reader (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`). `grep -rn process.env src/` shows hits only here.
- `src/prompt.ts` — `GENERATION_INSTRUCTIONS` + `buildGenerationPrompt`. Enforces legal guardrails generically (no trademark named anywhere): original headline/description, neutral brand-free image prompt, strict JSON with exactly {headline, description, imagePrompt}.
- `src/brick.ts` — pure `wrapBrickStyle(imagePrompt, styleLanguage)`; style text comes from config, never hardcoded.
- `src/generator/subscription.ts` — `SubscriptionGenerator` (spawns `claude -p --bare --output-format json --model <model>`, prompt on stdin). Parses the outer envelope → defensive inner parse (fences/prose/whitespace) → normalized output. NEVER throws → returns `null` on any failure. Subprocess injected as `ClaudeRunner` for hermetic tests. Exported parse helpers: `extractResultText`, `extractJsonObject`, `parseGeneratorOutput`.
- `src/generator/apikey.ts` — `ApiKeyGenerator` stub, throws `NotImplemented` (Slice 2b).
- `src/generator/index.ts` — `createGenerator(config, {runner?})`, provider-selected, default subscription.
- `src/generate.ts` — pure `generateAll(config, manifest, deps, {limit?})`. Presence-based idempotency (`isGenerated` = all four fields), all-or-nothing writes, never-partial, resilient (one failure → pending, run continues). `opts.limit` caps attempts (not skips).
- `src/generate-cli.ts` — CLI (`npm run generate`, `-- --limit N`).
- Config: `generator.provider` ("subscription"|"apikey", default subscription), `generator.model` (default `claude-sonnet-5`), `brickStyle.styleLanguage` (required).
- Tests: **78 passing** (vitest), subprocess boundary mocked, no network/token. `grep -rn process.env src/` clean; `grep -rin lego src/ config.example.json` empty.

Verified end-to-end:
- Real `claude -p` invocation confirmed the CLI envelope shape and the never-throw path: with no credentials in this env the child returns `is_error:true`/exit 1 → all attempted stories left **pending** (retry next run). Never crashes.
- Success path driven through the real orchestrator + subscription parser + brick wrapper + manifest I/O with an injected runner returning a real-shaped (fenced) envelope: 3-then-all-38 generated with all four fields, neutral image prompts, config brick style applied; a second run over the fully-generated manifest regenerated **nothing** (all skipped, generator never called).

## Next up
- Slice 2b: implement `ApiKeyGenerator` (Messages API via `ANTHROPIC_API_KEY` from `src/secrets.ts`).
- Later slices per ADR: imagegen integration (LAN microservice, prompt-agnostic), image storage (URL-referenced, never in git), static page rendering + publish, age-out + artifact deletion.

## Open questions / blocked / known limitations
- **Live success-path generation needs subscription credentials.** This headless
  cycle has no `CLAUDE_CODE_OAUTH_TOKEN` and cannot run interactive `/login`, so a
  real model call returns "Not logged in". The code is proven against the real CLI
  envelope shape and via the injected-runner end-to-end run; a real success run just
  needs `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in env. Not a code defect.
- **Redirect resolution is a no-op against today's Google News** (from Slice 1). GN
  serves a JS interstitial, so stories hash the wrapped `CBM…` link. Identity/dedup
  stay stable. GN URL decoding remains deliberately deferred.
