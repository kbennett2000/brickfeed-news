# Handoff

## Current state
**Slice 6 (category + caption on the generation contract)** is built on branch
`slice-6-category-caption` (off `slice-4-storage-publish`) with an open PR (see issue #11).
It amends ONLY the generation + manifest/publish shape — no ingestion, image, or storage
changes.

Slice 6 — the Generator normalized output goes from `{headline, description, imagePrompt}`
to `{headline, description, imagePrompt, category, caption}`:
- `src/category.ts` — NEW single source of truth: the fixed 8-section nav
  `CATEGORIES = [WORLD, POLITICS, BUSINESS, TECHNOLOGY, SCIENCE, SPORT, CULTURE, OPINION]`,
  `type Category`, `DEFAULT_CATEGORY = "WORLD"`, and `normalizeCategory(v)` (trim+upcase,
  invalid/missing → WORLD, never throws). A CODE CONSTANT (not config) so the pure
  `prompt.ts`/`parse.ts` seams import it directly.
- `src/prompt.ts` — `GENERATION_INSTRUCTIONS` now asks for FIVE keys; injects the enum list
  for `category` (pick exactly one), and a `caption` (~8–15 word neutral photo caption of the
  imagePrompt scene, same no-text/no-brand rules, NO credit/byline — the "/ BRICKFEED STUDIO"
  credit is appended render-side). Strict-JSON reaffirmed to exactly the 5 keys. Still names
  no brick/toy/lego (regression anchor holds).
- `src/generator/parse.ts` — extracts the 2 new keys: `caption` is REQUIRED like the other text
  fields (missing/empty → whole parse null → story stays pending); `category` is NEVER null —
  `normalizeCategory` defaults it to WORLD. Both providers (grok/subscription) call this shared
  parser unchanged.
- `src/generate.ts` — `isGenerated` now also requires `category` + `caption`, so a record
  generated BEFORE this slice (has the 4 old gen fields, lacks these) is treated as still-pending
  and BACKFILLS on the next run. All-or-nothing write now includes both new fields.
- `src/publish.ts` — `isPublishable` now also requires `category` + `caption` (no half-formed
  publish). `published.json` is a whole-record array, so it already carries both fields once
  present — doc updated, test confirms.
- `src/types.ts` — `GeneratorOutput` gains `category: Category` + `caption: string`;
  `ManifestRecord` gains optional `category?`/`caption?`.
- Enum defined as a constant → NO `config.example.json` change. `secrets.ts` untouched.
- Tests: **192 passing** (was 173, +19): `test/category.test.ts` (enum + normalize/fallback),
  prompt anchors (5 keys, enum listed, caption neutral, no brick/toy/lego), both providers parse
  5-key JSON + invalid/missing category → WORLD + missing caption → null, generate backfill +
  all-six persistence + round-trip, publish gate + `published.json` carries both. Both gates
  clean: `grep -rn process.env src/` → only `secrets.ts`; `grep -rin lego src/ config.example.json`
  → empty. `tsc --noEmit` clean.

Verified end-to-end (Slice 6) — LIVE against the real `claude` model (subscription path; note the
production runner's `--bare` flag is not logged-in in this box, so verification used a non-`--bare`
runner over the real CLI, which IS authenticated): generated 2 real pending stories → each got a
valid enum `category` (POLITICS) and a short neutral `caption` (12 & 14 words, no brand/text/brick).
Then stripped `category`+`caption` from one generated record → `isGenerated` = false → re-ran →
it regenerated and refilled both fields (`isGenerated` = true). The real working `data/manifest.json`
was NOT mutated (verification ran in-memory). Follow-up for the owner: the default `SubscriptionGenerator`
runner uses `claude -p --bare ...`; in this environment `--bare` reports "Not logged in" while plain
`claude -p` authenticates — if live subscription generation stays empty, that flag is the likely cause.

**Branch stacking note:** `slice-6-category-caption` is based on `slice-4-storage-publish`.
Merge order: Slice 2 → 2c → 3 → 4 → 6.

---

**Slice 4 (StorageProvider + image-gated publish + age-out)** is built on branch
`slice-4-storage-publish` (off `slice-3-image-provider`) with an open PR (see issue #9).
This is the LAST backend slice — it ends at a manifest carrying durable image URLs plus a
derived `published.json`. NO page render / HTML / UI (that's the next slice).

Storage + publish + age-out (Slice 4 — durable images, idempotent, image-gated):
- `src/storage/blob.ts` — `BlobStorageProvider` (DEFAULT) behind the new `StorageProvider`
  interface. Raw `fetch` (no SDK/deps) to Vercel Blob: `PUT {api}/{pathPrefix}{id}.png`
  with `Authorization: Bearer BLOB_READ_WRITE_TOKEN`, `x-add-random-suffix: 0`
  (deterministic/overwrite). Returns the deterministic public URL
  `{publicBaseUrl}/{pathPrefix}{id}.png`; `delete(id)` reconstructs that URL and POSTs
  `{api}/delete`. NEVER-THROW: `put`→null (story stays unpublished), `delete` failures
  logged/non-fatal. HTTP boundary injected as `StorageHttpRunner`.
- `src/storage/local.ts` — `LocalStorageProvider` (ALT). Atomic write (temp+rename) to a
  configured dir; returns `{publicBaseUrl}/{id}.png`; `delete` unlinks (ENOENT non-fatal).
  FS boundary injected (`StorageFs`).
- `src/storage/index.ts` — `createStorageProvider(config, { runner?, fs? })`: default
  `"blob"`, switchable `"local"`; advisory warn on missing token. Mirrors the image factory.
- `src/image.ts` — `generateImages` REWRITTEN to the real gen→store→persist pass (replaces
  Slice 3's `out/` sink). For each record with a `wrappedPrompt` and NO `imageUrl`:
  `provider.generate` → `storage.put` → persist `imageUrl`+`imageStoredAt` (all-or-nothing,
  immutable-copy manifest like `generateAll`). Idempotent: presence of `imageUrl` skips the
  record entirely (never re-gen, never re-upload). Returns `{ stored, skipped, failed, manifest }`.
- `src/publish.ts` — pure `isPublishable(r)` (headline + description + imageUrl) +
  `publishableRecords(manifest)` (newest-first by `firstSeen`) + `writePublished` (derived
  `published.json`). The seam the render slice will consume — NOTHING is rendered here.
- `src/ageout.ts` — `ageOut(config, manifest, { storage, now })`: drops records whose
  `lastSeen` is older than `config.maxAgeHours` AND `storage.delete(id)` for those with an
  image (real artifact cleanup). Record is dropped regardless of delete outcome — NO
  tombstone/retry (accepted trade: a rare orphaned blob; justified in ADR-0004 / PR).
- `src/image-cli.ts` — REWRITTEN: gen→store→persist, `writeManifest`, `writePublished`.
  `out/`/`writeOutImage` removed. `src/ageout-cli.ts` — new `npm run ageout`.
- `src/types.ts` — added `imageUrl?`/`imageStoredAt?` to `ManifestRecord`, `StorageProvider`,
  `StorageHttpRunner`, `StorageFs`; `ImageDeps.writeImage` → `storage: StorageProvider`.
- `src/secrets.ts` — added `getBlobReadWriteToken()` (`BLOB_READ_WRITE_TOKEN`); still the
  ONLY env reader.
- Config: added `storage.provider` (`"blob"|"local"`, default `"blob"`),
  `storage.blob.{pathPrefix "images/", publicBaseUrl}` (publicBaseUrl is the store's public
  host — required for live delete/URLs; may be "" until then), `storage.local.{dir, publicBaseUrl}`,
  `maxAgeHours` (default 72), `publishedPath` (default `data/published.json`).
  `config.example.json` updated. `docs/adr/0004-storage-and-publish.md` records the decisions.
- Tests: **173 passing** (was 130), all boundaries mocked (storage HTTP/FS + image + clock),
  no real Blob/network/token. Both gates clean: `grep -rn process.env src/` → only
  `secrets.ts`; `grep -rin lego src/ config.example.json` → empty.

Verified end-to-end (Slice 4):
- **Live storage chain proven via the local path** (the reachable, token-free proof, mirroring
  Slice 3's smoke test). Real `image-cli` drove `createImageProvider`→local imagegen (:8189,
  reachable) → real bytes → `createStorageProvider`→`LocalStorageProvider` → real FS write →
  manifest `imageUrl`+`imageStoredAt` write-back → derived `published.json`. Result: a valid
  1024×1024 PNG — a convincing generic-brick, **text-free, on-topic** riverside-park diorama
  (brick look from our prompt wrapping, no LoRA — the legal guardrail holds through storage).
  **Idempotency:** a second `images` run stored 0 / skipped 1, file mtime unchanged (no
  re-upload). **Age-out:** forcing `lastSeen` past `maxAgeHours` then `ageout` dropped the
  record from manifest + `published.json` AND deleted the stored file for real.
- **The one unproven surface: the Vercel Blob HTTP put/delete against a real store.** It needs
  `BLOB_READ_WRITE_TOKEN`, which was NOT present in this run's process env (the box's config
  also has no `storage`/`image` block yet — my per-field defaults cover that). The Blob path is
  fully mock-proven in `test/storage.blob.test.ts` (request shape, overwrite header, durable
  URL, delete URL reconstruction, never-throw). **Action for whoever has the token:** set
  `BLOB_READ_WRITE_TOKEN` + `storage.blob.publicBaseUrl` in `config.json`, run
  `npm run generate && npm run images`, confirm each publishable record's Blob URL loads a real
  brick image in a browser, re-run (stores nothing), and force one age-out (Blob object 404s).
- Note: the Grok-Imagine default image path still gates on `XAI_API_KEY` (a pre-existing Slice 3
  concern; the owner runs Grok via subscription). Out of Slice 4 scope — flagged for a follow-up.

**Config migration (action for whoever runs the orchestrator):** add a `storage` block +
`maxAgeHours` + `publishedPath` to local `config.json` (all default if omitted; but
`storage.blob.publicBaseUrl` must be set for live Blob). See `config.example.json`.

**Branch stacking note:** `slice-4-storage-publish` is based on `slice-3-image-provider`.
Merge order: Slice 2 → 2c → 3 → 4.

---

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
