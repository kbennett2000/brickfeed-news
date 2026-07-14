# Architecture

A current-state map of how brickfeed-news is built. The ADRs under [adr/](adr/) record the
*decisions* (and why); this document describes *what exists now* — the modules, the data flow
of one cycle, and the invariants that hold it together.

## Runtime model

- **One-shot, not resident.** There is no scheduler or main loop inside the process. A run is
  a single pass of `runCycle` ([src/cycle.ts](../src/cycle.ts)). Cron drives it on a schedule
  (see [INSTALL.md](INSTALL.md)); each invocation reads state from disk, does its work, writes
  state back, and exits.
- **TypeScript via `tsx`.** No build step — `tsconfig.json` is `noEmit`; every entry point is
  `tsx src/<name>.ts`. ES modules (`"type": "module"`, NodeNext, `.js` import specifiers).
- **State on disk, images in the cloud.** Story state is a JSON manifest
  (`data/manifest.json`); the newest-first publishable slice is `data/published.json`; the
  rendered static site is `site/`. Generated image *bytes* live in object storage (Vercel
  Blob by default), referenced from records by URL — never committed to git.
- **Injectable boundaries.** Every side effect (HTTP fetch, the generator/image/storage
  providers, the deploy subprocess, filesystem IO) is passed in as a dependency. Production
  wiring lives in the `*-cli.ts` files and `defaultCycleIo`; tests inject fakes, so the whole
  suite runs with no network, no GPU, and no running services.

## Data flow of one cycle

`runCycle` ([src/cycle.ts](../src/cycle.ts)) runs the stages in a fixed order, persisting the
manifest after each mutating stage:

```
readManifest(config.manifestPath)
storage.preflight()                        abort loud if misconfigured (non-dry-run)
── pipeline (each mutating stage: run → writeManifest) ──
1. headshots  runHeadshots()   hash-gated persona headshot optimize + upload (ADR-0013); tolerant
2. ingest     ingest()         fetch feeds → resolve redirects → story id → dedup
3. generate   generateAll()    text (headline/description/prompt/caption) → wrapBrickStyle
4. opinions   runOpinions()    publish-hour gated; topic gate → persona pieces + hero brief (ADR-0013–0018)
5. image      generateImages() slot/hero eligibility → ImageProvider.generate → StorageProvider.put  (+ writePublished)
6. ageout     ageOut()         drop stale records + StorageProvider.delete     (+ writePublished)
── after pipeline ──
staleness probe:  opinionStaleness() → logs OPINION-STALE if newest opinion > 36h (ADR-0018); never mutates
render:  verifiedPublishableRecords(manifest, storage)
         + loadAds(assets/ads) + loadArticles(assets/articles)   (operator content, uploaded to storage)
         + buildAuthorDirectory(personas, headshots)             (opinion bylines / bio pages, ADR-0019)
         → renderSite() → io.writeSite(outputDir)
deploy:  deploy(config, {files, publishableCount}) → shells `vercel --prod --yes`
```

Opinions run **before** image (ADR-0016) so a fresh opinion piece can be imaged and hero the same
cycle. The opinions and headshots stages are internally tolerant — an opinion/headshot problem is
logged and skipped, never breaking the news cycle. The render stage also folds in two
operator-managed, git-ignored content sources loaded from disk: **banner ads** (`assets/ads/`,
[ADS.md](ADS.md)) and **locally hosted articles** (`assets/articles/`, [ARTICLES.md](ARTICLES.md))
— see the render module rows below.

- Every stage is **never-throw at the story level**: a single bad story is skipped and stays
  pending for a later cycle. A stage that genuinely *throws* (e.g. a disk write fails) aborts
  the run **before deploy** and exits non-zero, so a broken run can't publish.
- **`--dry-run`** logs intended actions and mutates nothing (no provider is touched).
  **`--no-deploy`** runs every stage but skips the Vercel push (inspect `site/` locally).

## Invariants

Three rules are the backbone of correctness. Everything else serves them.

1. **Story identity = hash of the resolved URL.** [src/id.ts](../src/id.ts): `normalizeUrl`
   lowercases the host and strips query/fragment/trailing slash, then `storyId` is the sha256
   hex of that. Google News links are redirect wrappers, so [src/resolve.ts](../src/resolve.ts)
   resolves each to its real destination *before* hashing. Dedup, "is new", and age-out all
   key off this one ID.
2. **Idempotent generation.** Field writes are all-or-nothing: a record either gets its full
   set of generated fields (or its image) or none. A story that already has generated text is
   not re-generated; a story that already has a resolvable image is never re-imaged. So a
   cycle can be re-run safely and a partial failure heals on the next pass.
3. **Image-existence gate — never publish a broken frame.** A record is publishable only if
   its image *actually resolves in the current store*, not merely if an `imageUrl` string is
   present. This is enforced in three cooperating places (added in the "go live" cycle,
   commit `70c7528`):
   - `StorageProvider.exists(id, imageUrl?)` — verifies the artifact behind a stored URL
     (blob: a HEAD → 200; local: `stat` with size > 0).
   - `verifiedPublishableRecords()` ([src/publish.ts](../src/publish.ts)) — only records that
     pass `exists()` reach the rendered page and the deploy count.
   - `storage.preflight()` runs up front, and `generateImages` reclears any `imageUrl` that no
     longer resolves (e.g. after a provider switch) so it is re-imaged into the current store.
   The deploy step additionally refuses an empty/invalid render (`refused-empty`), so a bad
   pipeline run can never overwrite a good live site.

## Provider matrix

Three independent seams, each an interface with swappable implementations selected by
`config.json`. All implementations are never-throw (they return `null` on failure so the
owning stage can leave the story pending).

Two things to keep distinct: the **code-level default** (used when a `provider` key is omitted)
and the **live production selection** (what the committed `config.json` actually sets):

| Seam | Config key | Implementations | Code default | Production (ADR-0011) | Selector |
| --- | --- | --- | --- | --- | --- |
| Text generator | `generator.provider` | `grok-terminal` (keyless CLI), `grok` (xAI API), `claude` (subscription `claude -p`), `apikey` (throwing stub) | `grok-terminal` | **`claude` / Haiku** | [src/generator/index.ts](../src/generator/index.ts) `createGenerator` |
| Image provider | `image.provider` | `grok-terminal` (keyless CLI `/imagine`), `grok` (xAI API), `local` (LAN imagegen) | `grok-terminal` | **`grok-terminal`** | [src/image/index.ts](../src/image/index.ts) `createImageProvider` |
| Storage | `storage.provider` | `blob` (Vercel Blob), `local` (writes into `site/images`) | `blob` | **`blob`** | [src/storage/index.ts](../src/storage/index.ts) `createStorageProvider` |

Production moved **text** generation to `claude`/Haiku (`claude-haiku-4-5-20251001`) while
**images** stay on keyless `grok-terminal` (ADR-0011); the code default remains `grok-terminal`
for both. A separate opt-in local text-transform provider (`generator.tts`, all flags off by
default) can route individual text tasks to a LAN service with failover (ADR-0021/0022).

"Keyless" means the `grok` CLI is authenticated once interactively (a subscription login) and
no generation API key is needed at run time; the `claude` path likewise uses the CLI's stored
subscription login. Only the Vercel Blob token is required for storage. See
[CONFIGURATION.md](CONFIGURATION.md) for which environment variable each provider needs.

## Module map (`src/`)

### Orchestration & entry points

| File | Responsibility |
| --- | --- |
| [src/cycle.ts](../src/cycle.ts) | `runCycle` — the full-cycle orchestrator; threads and persists the manifest across all stages; `defaultCycleIo` is the production IO boundary |
| [src/cycle-cli.ts](../src/cycle-cli.ts) | `npm run cycle` — parses `--dry-run`/`--no-deploy`, wires real deps (fetch, the three provider factories, `defaultDeployRunner` that shells `vercel`), prints a per-stage summary, exits non-zero on hard failure |
| [src/index.ts](../src/index.ts) | `npm run ingest` — one ingest pass, persists the manifest |
| [src/generate-cli.ts](../src/generate-cli.ts) | `npm run generate` (`--limit N`) — runs `generateAll` |
| [src/image-cli.ts](../src/image-cli.ts) | `npm run images` (`--limit N`) — runs `generateImages`, persists manifest + `published.json` |
| [src/ageout-cli.ts](../src/ageout-cli.ts) | `npm run ageout` — runs `ageOut` |
| [src/render-cli.ts](../src/render-cli.ts) | `npm run render` — reads `published.json`, calls `renderSite`, writes files to `outputDir` |
| [src/opinions-cli.ts](../src/opinions-cli.ts) | `npm run opinions` (`--date`, `--authors all\|name,name`, `--dry-run`) — runs the opinion stage for one day, **bypassing** the publish-hour gate (ADR-0015) |
| [src/headshots-cli.ts](../src/headshots-cli.ts) | `npm run headshots` — hash-gated persona headshot optimize + upload, standalone (ADR-0013 d.8) |
| [src/backfill-optimize.ts](../src/backfill-optimize.ts) | `npm run backfill-optimize` — one-off maintenance: re-run already-stored images through the optimizer + rewrite their URLs |

### Shared contracts, config, secrets

| File | Responsibility |
| --- | --- |
| [src/types.ts](../src/types.ts) | All shared interfaces: `FeedItem`, `ManifestRecord`, `Manifest`, `Generator`/`GeneratorOutput`, `ImageProvider`, `StorageProvider`, and every injectable boundary type (`FetchLike`, `ClaudeRunner`, `DeployRunner`, `CycleIo`/`CycleDeps`, …) |
| [src/config.ts](../src/config.ts) | `Config` + sub-interfaces, `loadConfig`/`validateConfig`, all `DEFAULT_*` constants, enum validation with the `"subscription"` → `"claude"` back-compat alias. Reads no env |
| [src/secrets.ts](../src/secrets.ts) | The **only** module that reads `process.env`: `getSubscriptionToken`, `getApiKey`, `getXaiApiKey`, `getBlobReadWriteToken`, `getVercelToken` |
| [src/category.ts](../src/category.ts) | The fixed section taxonomy: `CATEGORIES` (8 names), `Category`, `DEFAULT_CATEGORY`, `normalizeCategory` |

### Ingestion backbone (fetch → resolve → identity → dedup)

| File | Responsibility |
| --- | --- |
| [src/ingest.ts](../src/ingest.ts) | `ingest` — fetch all feeds, resolve each link, compute the ID, classify NEW vs KNOWN against the manifest |
| [src/rss.ts](../src/rss.ts) | `fetchFeed`/`parseFeed` — tolerant `fast-xml-parser` RSS parsing (Google News `<source>` supported); never throws (bad feed → `[]`) |
| [src/resolve.ts](../src/resolve.ts) | `resolveUrl` — follows the Google News redirect to the real destination (8 s timeout); never throws |
| [src/id.ts](../src/id.ts) | `normalizeUrl` + `storyId` — the canonical story identity |
| [src/manifest.ts](../src/manifest.ts) | `readManifest`/`writeManifest` (atomic temp-file + rename), `emptyManifest`, `MANIFEST_VERSION`; missing/corrupt → empty |

### Text generation

| File | Responsibility |
| --- | --- |
| [src/generate.ts](../src/generate.ts) | `generateAll` — for each pending record, call the Generator, wrap `imagePrompt` via `wrapBrickStyle`, write all fields all-or-nothing; concurrent, idempotent |
| [src/prompt.ts](../src/prompt.ts) | `GENERATION_INSTRUCTIONS` (the legal-guardrail system prompt) + `buildGenerationPrompt` — the single prompt shared by every text provider |
| [src/brick.ts](../src/brick.ts) | `wrapBrickStyle` — the single styling chokepoint that prepends the config brick-style language to the neutral scene |
| [src/generator/index.ts](../src/generator/index.ts) | `createGenerator` — selects the impl by `generator.provider`; advisory env preflight warnings |
| [src/generator/grokTerminal.ts](../src/generator/grokTerminal.ts) | `GrokTerminalGenerator` — keyless prod default; drives the `grok` CLI headlessly in a caged temp cwd |
| [src/generator/grok.ts](../src/generator/grok.ts) | `GrokGenerator` — xAI HTTP `chat/completions` (OpenAI-compatible envelope) |
| [src/generator/subscription.ts](../src/generator/subscription.ts) | `SubscriptionGenerator` — `claude -p --output-format json` via the subscription token |
| [src/generator/apikey.ts](../src/generator/apikey.ts) | `ApiKeyGenerator` — documented stub (Messages API), `generate()` throws `NotImplemented` |
| [src/generator/parse.ts](../src/generator/parse.ts) | `parseGeneratorOutput` — shared defensive inner-JSON parser (strips fences/prose, validates fields); never throws |
| [src/generator/text.ts](../src/generator/text.ts) | `createTextGenerator` — free-form (prompt-in, text-out) seam over the SAME providers, used by the opinion stage + persona bench (ADR-0013); prompt assembly stays with callers |
| [src/generator/tts.ts](../src/generator/tts.ts) | `TtsClient` + the `story-cover` adapter for the opt-in local `text-transform-service` provider (ADR-0022); returns subject-neutral prompts, fails over to the incumbent |

### Image generation

| File | Responsibility |
| --- | --- |
| [src/image.ts](../src/image.ts) | `generateImages` — reclears stale image refs, then for each record with a `wrappedPrompt` and no image: `provider.generate` → `storage.put`, all-or-nothing; `detectImageContentType` sniffs JPEG/PNG/WebP magic bytes |
| [src/image/index.ts](../src/image/index.ts) | `createImageProvider` — selects by `image.provider` |
| [src/image/grokTerminal.ts](../src/image/grokTerminal.ts) | `GrokTerminalImageProvider` — keyless prod default; drives `grok /imagine`, then locates the file grok wrote to disk (`findGrokImagePath` / salvage scan) |
| [src/image/grok.ts](../src/image/grok.ts) | `GrokImageProvider` — xAI `images/generations` then GET the ephemeral URL for bytes |
| [src/image/local.ts](../src/image/local.ts) | `LocalImageProvider` — POST to the LAN imagegen microservice with base (no-LoRA) style |
| [src/image/optimize.ts](../src/image/optimize.ts) | `optimizeImage` — the `sharp`-backed downscale + WebP re-encode used by the storage optimizer (`config.image.optimize`, ADR-0012) |
| [src/eligibility.ts](../src/eligibility.ts) | `heroEligibility` + `SECTION_SLOT_LIMIT` — pure slot-based hero rule so the image budget and the render's display bound share one constant (ADR-0020); OPINION exempt |

### Storage, publish gate, age-out

| File | Responsibility |
| --- | --- |
| [src/storage/index.ts](../src/storage/index.ts) | `createStorageProvider` — selects by `storage.provider` |
| [src/storage/blob.ts](../src/storage/blob.ts) | `BlobStorageProvider` — Vercel Blob via raw fetch; deterministic key `{pathPrefix}{id}{ext}` (overwrites in place); `put`/`delete`/`exists`/`preflight`; needs `BLOB_READ_WRITE_TOKEN` |
| [src/storage/local.ts](../src/storage/local.ts) | `LocalStorageProvider` — atomic write into a dir (default `site/images`), returns a relative `images/<id>.<ext>` URL that ships with the site |
| [src/storage/optimizing.ts](../src/storage/optimizing.ts) | `withImageOptimization` — wraps the chosen provider so every `put` runs bytes through `optimizeImage` first (single chokepoint for stories, ads, articles; `config.image.optimize.enabled`) |
| [src/publish.ts](../src/publish.ts) | `isPublishable`, `publishableRecords` (newest-first), `verifiedPublishableRecords` (adds the async `exists` gate), `writePublished` (atomic write of `published.json`) |
| [src/ageout.ts](../src/ageout.ts) | `ageOut` — drop records past `maxAgeHours` and `storage.delete` their image for real; the drop always wins over a delete failure |

### Deploy & render

| File | Responsibility |
| --- | --- |
| [src/deploy.ts](../src/deploy.ts) | `deploy` — shells the configured command (default `vercel --prod --yes`, cwd `site/`); refuses an empty render (`refused-empty`); never throws. Statuses: `deployed`, `failed`, `refused-empty`, `skipped-flag`, `skipped-disabled` |
| [src/render/index.ts](../src/render/index.ts) | `renderSite` — pure core: records + ads + articles + opinion authors + clock in; emits `index.html`, one `<slug>.html` per category, a per-story `s/<id>.html` landing page each (ADR-0009), a per-columnist `columnist/<name>.html` bio page (ADR-0019), `share.html`, `about.html`, `styles.css`, plus the deploy-root artifacts from `site-config.ts` (`vercel.json`/`robots.txt`/`sitemap.xml`). Merges local articles into the cover/section lists by rank (`insertRanked`) and drops expired ones; opinions render only in the Opinion section (ADR-0016). `toStoryView`/`articleToStoryView` reduce a record/article to display fields |
| [src/render/templates.ts](../src/render/templates.ts) | HTML partials as template literals: masthead, nav, lead/rail/card, figure + placeholder, footer, page shell, plus `renderLandingPage` (per-story page + `cardMeta` OG/Twitter card), `renderShareSheet` (X share sheet), and `renderAbout`; nav/footer built from `CATEGORIES` |
| [src/render/format.ts](../src/render/format.ts) | Pure formatters/escapers: `escapeHtml`/`escapeAttr`, `formatMastheadDate`, `editionLabel` (time-of-day edition, ADR-0008), `relativeTime`, `sectionSlug`, `titleCase`, `bylineFor`, `storyPageUrl` + `buildXIntentUrl` (ADR-0009), `hashString` (deterministic rank-0 article placement) |
| [src/render/markdown.ts](../src/render/markdown.ts) | `renderMarkdown` — wraps `marked` to render a local article's markdown body to HTML (the one non-hand-rolled render path; ADR-0010) |
| [src/render/styles.ts](../src/render/styles.ts) | `STYLES` — the site's chrome CSS as a committed string constant (+ ad-banner crossfade CSS) |
| [src/render/rotator.ts](../src/render/rotator.ts) | The banner-ad rotator (ADR-0017): pure per-load Fisher–Yates shuffle + crossfade, unit-tested then embedded into the shipped inline script via `Function.prototype.toString()` |
| [src/render/site-config.ts](../src/render/site-config.ts) | Deploy-root artifacts the render emits alongside the HTML (ADR-0012): `vercel.json` (image-optimization allow-list), `robots.txt`, `sitemap.xml` — pure string builders |

### Operator content (ads & articles)

Two git-ignored content sources the operator manages by dropping files into `assets/`, loaded
at render time and uploaded to storage like story images. Both are tolerant/never-throw (a bad
file drops just that item).

| File | Responsibility |
| --- | --- |
| [src/ads.ts](../src/ads.ts) | `loadAds` + `ADS_DIR` — pair image + single-URL `.md` under `assets/ads/` by basename, upload each image under `ads/<base>`, return `AdView`s for the leaderboard banner. See [ADS.md](ADS.md) |
| [src/articles.ts](../src/articles.ts) | `parseArticle` (pure) + `loadArticles` + `ARTICLES_DIR` — pair image + structured `.md` under `assets/articles/`, upload under `articles/<base>`, return `Article`s (headline/byline/section/rank/expiry/markdown body) merged into the render as on-site stories. See [ARTICLES.md](ARTICLES.md) and ADR-0010 |

`assets/` layout: `assets/ads/` (banner ads), `assets/articles/` (local articles), and
`assets/about-portrait.jpg` (the About-page portrait). The whole tree is git-ignored — images
are uploaded to storage and referenced by URL, never committed.

### Opinion section (columnists, letters, headshots)

The Opinion section (ADR-0013 through ADR-0019) adds disclosed AI columnists whose pieces are
generated through the free-form text seam, published as `OPINION`-category records, imaged like
any story, and rendered only within the Opinion section. Personas are versioned prompt assets;
their headshots and bio pages are operator content that never enters git.

| File | Responsibility |
| --- | --- |
| [src/opinions.ts](../src/opinions.ts) | `runOpinions` + the stage internals — author derivation (rotation pairs ADR-0013 + letters schedule ADR-0014), bias-weighted candidate selection, the batched **fail-closed** topic gate (ADR-0015), per-author piece + image-brief generation (ADR-0016), idempotency key `opinion-{author}-{date}`, and the `OPINION-STALE` staleness probe (ADR-0018) |
| [src/opinions-tts.ts](../src/opinions-tts.ts) | The `opinion-gate` (fail-closed) and `opinion-image-brief` (failover) adapters for the opt-in TTS provider (ADR-0022); kept out of `opinions.ts` so the stage stays provider-agnostic |
| [src/personas.ts](../src/personas.ts) | Loads + strictly validates `personas/*.md` (front-matter + voice body), `_shared.md` guardrails, `_letters.md` overlay, optional human-written `bio` (ADR-0019); a malformed persona fails the schema tests loudly |
| [src/headshots.ts](../src/headshots.ts) | `runHeadshots`/`processHeadshots` — hash-gated 256×256 avatar optimize + upload for each `assets/headshots/<name>.png` through the same storage path (ADR-0013 d.8); records a small derived manifest for the render's bylines/bio pages |

Persona assets, the letters overlay, the disclosure copy, and the render surfaces (opinion page,
per-columnist `columnist/<name>.html` bio pages ADR-0019, cast strip, disclosures) are covered in
[opinion-runbook.md](opinion-runbook.md).

### Utility

| File | Responsibility |
| --- | --- |
| [src/pool.ts](../src/pool.ts) | `mapWithConcurrency` — bounded-concurrency map, results in input order; used by generate, image, and publish verification |

## Testing

The suite is vitest, zero-config (no `vitest.config.*`), living in `test/` (47 `*.test.ts`
files, ~740 tests, with shared fakes in `test/helpers.ts` and `test/fixtures.ts`). Every
boundary is injected, so tests are hermetic — no live network, no running imagegen, no GPU. Run
with `npm test`. Coverage spans RSS parsing, URL resolution, ID hashing, dedup, every generator
and image provider (including the free-form text seam and the TTS client/adapters), storage
(blob + local + the optimizing wrapper), the publish gate, age-out, concurrency, deploy, the
opinion stage (personas, gate, selection, rendering), headshots, slot/hero eligibility, the
render (per-story pages, the ad rotator, local-article parsing/ranking/expiry), and the full
`runCycle` orchestrator. (An opt-in live TTS test is gated behind `TTS_LIVE=1` and skipped in CI.)

## See also

- [adr/0001-brickfeed-architecture.md](adr/0001-brickfeed-architecture.md) — the foundational decisions.
- [adr/0003-image-provider.md](adr/0003-image-provider.md), [adr/0004-storage-and-publish.md](adr/0004-storage-and-publish.md) — the provider/storage seams.
- [adr/0005-render.md](adr/0005-render.md) — the static render.
- [adr/0006-orchestrator-and-deploy.md](adr/0006-orchestrator-and-deploy.md), [adr/0007-grok-terminal-keyless-default-and-real-cli-contract.md](adr/0007-grok-terminal-keyless-default-and-real-cli-contract.md) — the cycle orchestrator, deploy, and the keyless default.
- [adr/0008-newest-first-imaging-and-edition-label.md](adr/0008-newest-first-imaging-and-edition-label.md) — newest-first imaging + the time-of-day edition label.
- [adr/0009-per-story-pages-and-x-share.md](adr/0009-per-story-pages-and-x-share.md) — per-story `s/<id>.html` landing pages + the X share sheet.
- [adr/0010-local-hosted-articles.md](adr/0010-local-hosted-articles.md) — locally hosted articles ([ARTICLES.md](ARTICLES.md)); banner ads are documented in [ADS.md](ADS.md).
- [adr/0011-claude-text-grok-images.md](adr/0011-claude-text-grok-images.md) — production text → Claude/Haiku, images stay Grok.
- [adr/0012-vercel-pro-and-per-story-share.md](adr/0012-vercel-pro-and-per-story-share.md) — responsive image optimization, deploy-root artifacts, per-story share buttons.
- [adr/0013-opinion-section-architecture.md](adr/0013-opinion-section-architecture.md) through [adr/0019-columnist-bio-pages.md](adr/0019-columnist-bio-pages.md) — the Opinion section (personas, letters, generation, rendering, operations, bio pages); operator guide in [opinion-runbook.md](opinion-runbook.md).
- [adr/0017-ad-rotator-and-byline-sizing.md](adr/0017-ad-rotator-and-byline-sizing.md) — the JS ad rotator.
- [adr/0020-slot-based-hero-eligibility.md](adr/0020-slot-based-hero-eligibility.md) — slot-based hero eligibility.
- [adr/0021-tts-local-provider.md](adr/0021-tts-local-provider.md), [adr/0022-tts-local-provider-implementation.md](adr/0022-tts-local-provider-implementation.md) — the opt-in local text-transform provider ([tts-inventory.md](tts-inventory.md)).
