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
── pipeline (each stage: run → writeManifest) ──
1. ingest    ingest()          fetch feeds → resolve redirects → story id → dedup
2. generate  generateAll()     text (headline/description/prompt/caption) → wrapBrickStyle
3. image     generateImages()  ImageProvider.generate → StorageProvider.put   (+ writePublished)
4. ageout    ageOut()          drop stale records + StorageProvider.delete     (+ writePublished)
── after pipeline ──
render:  verifiedPublishableRecords(manifest, storage) → renderSite() → io.writeSite(outputDir)
deploy:  deploy(config, {files, publishableCount}) → shells `vercel --prod --yes`
```

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
owning stage can leave the story pending). The **keyless production default** is
`grok-terminal` for text and image with `blob` storage.

| Seam | Config key | Implementations (default **bold**) | Selector |
| --- | --- | --- | --- |
| Text generator | `generator.provider` | **`grok-terminal`** (keyless CLI), `grok` (xAI API), `claude` (subscription `claude -p`), `apikey` (stub) | [src/generator/index.ts](../src/generator/index.ts) `createGenerator` |
| Image provider | `image.provider` | **`grok-terminal`** (keyless CLI `/imagine`), `grok` (xAI API), `local` (LAN imagegen) | [src/image/index.ts](../src/image/index.ts) `createImageProvider` |
| Storage | `storage.provider` | **`blob`** (Vercel Blob), `local` (writes into `site/images`) | [src/storage/index.ts](../src/storage/index.ts) `createStorageProvider` |

"Keyless" means the `grok` CLI is authenticated once interactively (a subscription login) and
no generation API key is needed at run time; only the Vercel Blob token is required for
storage. See [CONFIGURATION.md](CONFIGURATION.md) for which environment variable each
provider needs.

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

### Image generation

| File | Responsibility |
| --- | --- |
| [src/image.ts](../src/image.ts) | `generateImages` — reclears stale image refs, then for each record with a `wrappedPrompt` and no image: `provider.generate` → `storage.put`, all-or-nothing; `detectImageContentType` sniffs JPEG/PNG/WebP magic bytes |
| [src/image/index.ts](../src/image/index.ts) | `createImageProvider` — selects by `image.provider` |
| [src/image/grokTerminal.ts](../src/image/grokTerminal.ts) | `GrokTerminalImageProvider` — keyless prod default; drives `grok /imagine`, then locates the file grok wrote to disk (`findGrokImagePath` / salvage scan) |
| [src/image/grok.ts](../src/image/grok.ts) | `GrokImageProvider` — xAI `images/generations` then GET the ephemeral URL for bytes |
| [src/image/local.ts](../src/image/local.ts) | `LocalImageProvider` — POST to the LAN imagegen microservice with base (no-LoRA) style |

### Storage, publish gate, age-out

| File | Responsibility |
| --- | --- |
| [src/storage/index.ts](../src/storage/index.ts) | `createStorageProvider` — selects by `storage.provider` |
| [src/storage/blob.ts](../src/storage/blob.ts) | `BlobStorageProvider` — Vercel Blob via raw fetch; deterministic key `{pathPrefix}{id}{ext}` (overwrites in place); `put`/`delete`/`exists`/`preflight`; needs `BLOB_READ_WRITE_TOKEN` |
| [src/storage/local.ts](../src/storage/local.ts) | `LocalStorageProvider` — atomic write into a dir (default `site/images`), returns a relative `images/<id>.<ext>` URL that ships with the site |
| [src/publish.ts](../src/publish.ts) | `isPublishable`, `publishableRecords` (newest-first), `verifiedPublishableRecords` (adds the async `exists` gate), `writePublished` (atomic write of `published.json`) |
| [src/ageout.ts](../src/ageout.ts) | `ageOut` — drop records past `maxAgeHours` and `storage.delete` their image for real; the drop always wins over a delete failure |

### Deploy & render

| File | Responsibility |
| --- | --- |
| [src/deploy.ts](../src/deploy.ts) | `deploy` — shells the configured command (default `vercel --prod --yes`, cwd `site/`); refuses an empty render (`refused-empty`); never throws. Statuses: `deployed`, `failed`, `refused-empty`, `skipped-flag`, `skipped-disabled` |
| [src/render/index.ts](../src/render/index.ts) | `renderSite` — pure core: records + clock in, `index.html` + one `<slug>.html` per category + `styles.css` out; `toStoryView` reduces a record to display fields |
| [src/render/templates.ts](../src/render/templates.ts) | HTML partials as template literals (masthead, nav, lead/rail/card, figure + placeholder, footer, page shell); nav/footer built from `CATEGORIES` |
| [src/render/format.ts](../src/render/format.ts) | Pure formatters/escapers: `escapeHtml`/`escapeAttr`, `formatMastheadDate`, `relativeTime`, `sectionSlug`, `titleCase`, `bylineFor` |
| [src/render/styles.ts](../src/render/styles.ts) | `STYLES` — the site's chrome CSS as a committed string constant |

### Utility

| File | Responsibility |
| --- | --- |
| [src/pool.ts](../src/pool.ts) | `mapWithConcurrency` — bounded-concurrency map, results in input order; used by generate, image, and publish verification |

## Testing

The suite is vitest, zero-config (no `vitest.config.*`), living in `test/` (~30 `*.test.ts`
files with shared fakes in `test/helpers.ts` and `test/fixtures.ts`). Every boundary is
injected, so tests are hermetic — no live network, no running imagegen, no GPU. Run with
`npm test`. Coverage spans RSS parsing, URL resolution, ID hashing, dedup, every generator
and image provider, storage (blob + local), the publish gate, age-out, concurrency, deploy,
the render, and the full `runCycle` orchestrator.

## See also

- [adr/0001-brickfeed-architecture.md](adr/0001-brickfeed-architecture.md) — the foundational decisions.
- [adr/0003-image-provider.md](adr/0003-image-provider.md), [adr/0004-storage-and-publish.md](adr/0004-storage-and-publish.md) — the provider/storage seams.
- [adr/0005-render.md](adr/0005-render.md) — the static render.
- [adr/0006-orchestrator-and-deploy.md](adr/0006-orchestrator-and-deploy.md), [adr/0007-grok-terminal-keyless-default-and-real-cli-contract.md](adr/0007-grok-terminal-keyless-default-and-real-cli-contract.md) — the cycle orchestrator, deploy, and the keyless default.
