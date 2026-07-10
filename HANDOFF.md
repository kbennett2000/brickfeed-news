# Handoff

## Current state
Slice 1 (RSS ingestion) is merged to `master`. **Slice 2 (Claude generation layer)**
is built on branch `slice-2-claude-generation` with an open PR (see issue #3).
**Slice 2c (Grok generator + default provider)** is built on branch
`slice-2c-grok-generator` with an open PR (see issue #5).
**Slice 3 (ImageProvider layer)** is built on branch `slice-3-image-provider`
(off `slice-2c-grok-generator`) with an open PR (see issue #7).

Image layer (Slice 3 — Grok Imagine default, local imagegen alternative):
- `src/image/grok.ts` — `GrokImageProvider` (DEFAULT) behind the new `ImageProvider`
  interface. Raw `fetch` to xAI's OpenAI-compatible `POST {baseUrl}/images/generations`
  (no SDK), `Authorization: Bearer XAI_API_KEY`, model/aspectRatio/resolution from config.
  The response carries an EPHEMERAL image URL, so it downloads the bytes in the same call
  (two-step: POST for the url → GET the bytes) and returns them; the xAI URL is never
  passed downstream. NEVER throws → `null` on any failure (missing key, non-2xx, bad
  envelope, missing url, failed download). Exports `extractImageUrl` + a shared
  `defaultRunner` (raw-fetch → bytes). HTTP boundary injected as `ImageHttpRunner`.
- `src/image/local.ts` — `LocalImageProvider` (ALT). Raw `fetch` to `POST {url}/generate`
  with `{ prompt: wrappedPrompt, style }`; returns the raw PNG bytes. `style` is the
  BASE/no-LoRA style from config so brick styling isn't double-applied (the prompt already
  carries it). Unreachable/non-2xx/throw → `null`.
- `src/image/index.ts` — `createImageProvider(config, { runner? })`: default `"grok"`,
  switchable `"local"`. Advisory `console.warn` on missing `XAI_API_KEY`; never blocks.
- `src/image.ts` — pure `generateImages(config, manifest, deps, { limit? })`. For each
  record WITH a `wrappedPrompt`, calls the provider and hands bytes to the injected
  `writeImage` sink; records without a `wrappedPrompt` are skipped; a `null`/throw (or a
  failed write) leaves that record imageless and the run continues (resilient). `opts.limit`
  caps attempts. NOTE: no per-record "already has image" signal yet (that's Slice 4), so
  every `wrappedPrompt` record is (re)rendered each run.
- `src/image-cli.ts` — CLI (`npm run images`, `-- --limit N`). Writes bytes atomically to
  `out/<id>.png` (temp + rename), a gitignored TEMPORARY inspection sink. No manifest
  write-back. Slice 4 replaces `out/` with a StorageProvider + manifest persistence.
- `src/types.ts` — added `ImageProvider`, `ImageHttpRunner`, `ImageDeps`.
- Config: added `image.provider` (`"grok"|"local"`, default `"grok"`),
  `image.grok.{baseUrl (https://api.x.ai/v1), model (grok-imagine-image-quality),
  aspectRatio (1:1), resolution (1k)}`, `image.local.{url (http://localhost:8189),
  style (base)}`; all default per-field when omitted. `config.example.json` updated.
  `secrets.ts` unchanged — `getXaiApiKey()` reused.
- `.gitignore` — added `/out/`. `docs/adr/0003-image-provider.md` records the decisions
  (Grok Imagine default, ephemeral-URL download-in-call, `out/` temporary sink,
  `wrapBrickStyle` single-chokepoint invariant).
- Tests: **130 passing** (vitest), both HTTP boundaries mocked, no network/key required.
  Both gates clean: `grep -rn process.env src/` → only `secrets.ts`; `grep -rin lego src/
  config.example.json` → empty.

Verified end-to-end (Slice 3):
- **Live local-provider smoke test passed.** The imagegen service at `localhost:8189` was
  reachable, so the real `createImageProvider` → `LocalImageProvider` → real `fetch` was
  driven against it (scratch manifest, one `wrappedPrompt` record, style `base`). Result:
  `written:["smoke1"]`, a valid 1024×1024 PNG (1.4 MB) — a convincingly brick-styled,
  text-free, on-topic diorama. Crucially the brick look came from our GENERIC prompt
  wrapping (style `base` = prompt-only), NOT the service's `lego-style` LoRA — the legal
  guardrail holds end-to-end. (Service `/styles` does expose a `lego-style` LoRA; our
  default `base` deliberately avoids it.)
- Grok (default) live call still needs a real `XAI_API_KEY` (absent in this env). With no
  key the never-throw contract skips every story (no crash) — same proof standard as
  Slice 2/2c; the two-step POST→download logic and request shape are proven via the
  injected `ImageHttpRunner` in `test/image.grok.test.ts`.

**Branch stacking note:** `slice-3-image-provider` is based on `slice-2c-grok-generator`
(NOT `slice-2-claude-generation`), because Slice 3 reuses Slice 2c's `getXaiApiKey` and the
xAI infrastructure. Merge order: Slice 2 → Slice 2c → Slice 3.

Generation layer (Slice 2c — Grok, new default provider):
- `src/generator/grok.ts` — `GrokGenerator` behind the same `Generator` interface. Raw
  `fetch` to xAI's OpenAI-compatible `POST {baseUrl}/chat/completions` (no SDK), model from
  config (default `grok-4.5`), `Authorization: Bearer XAI_API_KEY`. Parses the chat envelope
  (`choices[0].message.content`) → inner JSON via the shared defensive parser. NEVER throws →
  `null` on any failure (missing key, transport error, non-2xx, bad envelope/JSON) → story
  stays pending. HTTP boundary injected as `GrokChatRunner` for hermetic tests.
- `src/generator/parse.ts` — the shared defensive inner-JSON parser (`extractJsonObject`,
  `parseGeneratorOutput`), extracted from `subscription.ts` so both providers share it;
  still re-exported from `subscription.ts` for existing importers.
- `src/generator/index.ts` — factory now selects `"grok"` (DEFAULT) / `"claude"` (subscription,
  **renamed** from `"subscription"`) / `"apikey"` (stub). Advisory preflight warns on missing
  key/token; never blocks.
- `src/secrets.ts` — added `getXaiApiKey()` (`XAI_API_KEY`). Still the ONLY env reader.
- `src/prompt.ts` — instructions refined (provider-agnostic, shared): punchy neutral headline;
  one-paragraph description; SHORT (~15–30 words) playful/cartoonish, purely-visual imagePrompt
  with hard rules — no text/letters/written words in the scene, no brand/trademark names, and
  **no brick/toy/lego language** (that styling is applied downstream by `wrapBrickStyle`, and the
  instruction text itself now names none of those terms — a regression anchor).
- Config: `generator.provider` now `"grok"|"claude"|"apikey"` (default `"grok"`);
  added nested `generator.grok.{baseUrl (default https://api.x.ai/v1), model (default grok-4.5)}`.
  Top-level `generator.model` still feeds the claude path.
- Tests: **99 passing** (vitest), HTTP/subprocess boundaries mocked, no network/token/key.
  Both gates clean: `grep -rn process.env src/` → only `secrets.ts`; `grep -rin lego src/
  config.example.json` → empty.

**Local-config migration (action for whoever runs the orchestrator):** the provider value
`"subscription"` was renamed to `"claude"`. Any local `config.json` must update
`generator.provider` accordingly (and may add the `generator.grok` block; it defaults if
omitted). The example was updated and the dev-box `config.json` was migrated to `"claude"`.

Verified end-to-end (Slice 2c):
- All three routes driven through the real orchestrator + CLI (`npm run generate`): `grok`
  (default), `claude`, and `apikey` each route correctly and never crash — with no key/token
  every attempted story is left **pending** (retry next run), same proof standard as Slice 2.
- Grok success path proven through the real `generateAll` with an injected HTTP boundary
  returning a real-shaped, ```json-fenced chat-completions envelope: normalized
  headline/description/imagePrompt written together, brick style wrapped, and a second run over
  the generated manifest regenerated nothing (HTTP runner never called → idempotent).
- Live model call still needs a real `XAI_API_KEY` (this headless env has none); not a code defect.

---


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
