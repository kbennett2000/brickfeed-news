# Configuration reference

brickfeed-news is configured by two separate things, kept strictly apart:

- **`config.json`** — all app settings (feeds, providers, styling, thresholds, deploy).
  Git-ignored; copy [../config.example.json](../config.example.json) to create it. Validated
  and defaulted by [../src/config.ts](../src/config.ts) (`loadConfig` / `validateConfig`).
- **Environment variables** — secrets only (API tokens). Read in exactly one module,
  [../src/secrets.ts](../src/secrets.ts). **Never** placed in `config.json`, never committed.

> The app does **not** load a `.env` file. Variables must be present in the process
> environment (export them from a shell profile, a systemd unit, or the cron environment —
> see [INSTALL.md](INSTALL.md) step 7).

Omitted `config.json` fields are filled with the defaults below by `validateConfig`, so a
minimal config is valid. Only **`feedUrls`** and **`manifestPath`** are strictly required
(the validator throws if they're missing or empty).

---

## `config.json` fields

### Top level

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `feedUrls` | string[] | — (**required**) | RSS feed URLs to ingest. Must be non-empty. |
| `manifestPath` | string | — (**required**) | Path to the story-state JSON manifest (example: `data/manifest.json`). |
| `publishedPath` | string | `data/published.json` | Path to the newest-first publishable slice the renderer reads. |
| `maxAgeHours` | number | `72` | Records whose `lastSeen` is older than this are aged out and their images deleted. |
| `opinionMaxAgeHours` | number | `168` | Retention window for OPINION stories only; all other categories use `maxAgeHours`. Never falls back to `maxAgeHours` (ADR-0013). |
| `opinionPublishHourUTC` | number | `13` | UTC hour (integer 0–23) the cycle's opinions stage first runs each day; the gate is `>=` so a missed tick self-heals next cycle. `npm run opinions` bypasses it (ADR-0018). |
| `concurrency` | number | `4` | Parallel stories processed in the generate and image stages. |
| `maxStoriesPerCycle` | number | `40` | Cap on new stories imaged per cycle, so a backlog spreads over several cron ticks. |
| `brickStyle.styleLanguage` | string | — (**required**) | The toy-brick style text wrapped around every image prompt. Kept in config, never hardcoded; generic bricks only (no trademark). |

### `generator` — text generation

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `generator.provider` | enum | `grok-terminal` | One of `grok-terminal` \| `grok` \| `claude` \| `apikey`. See the provider matrix below. |
| `generator.model` | string | `claude-sonnet-5` | Model for the `claude` (subscription) path. **Production overrides this to Haiku** (`claude-haiku-4-5-20251001`, ADR-0011) — the committed `config.json` sets it explicitly. |
| `generator.grok.baseUrl` | string | `https://api.x.ai/v1` | xAI API base URL (the `grok` provider). |
| `generator.grok.model` | string | `grok-4.5` | Model for the `grok` (xAI API) path. |
| `generator.grokTerminal.command` | string | `grok` | Executable for the keyless CLI path. |
| `generator.grokTerminal.args` | string[] | `[]` | Extra args passed to the CLI. |
| `generator.grokTerminal.timeoutMs` | number | `120000` | Per-story text timeout for the CLI path. |

> **Back-compat alias:** a `generator.provider` of `"subscription"` is accepted and mapped to
> `"claude"` with a one-time deprecation warning. Image and storage providers were never
> renamed.

#### `generator.tts` — opt-in local text-transform routing (ADR-0022)

An **optional** block that routes individual text tasks to a LAN `text-transform-service` (TTS)
instead of the incumbent `generator.provider`, per task, with failover. Omit the whole block (or
leave every flag `false`) and behavior is byte-identical to today — nothing routes to TTS. Each
flag is opt-in and independent; `opinion-piece` is intentionally **not** routable (held on the
incumbent). See ADR-0022 and [ARCHITECTURE.md](ARCHITECTURE.md).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `generator.tts.url` | string | `http://G434:8712` | Base URL of the TTS service. Non-secret endpoint (lives in config, not env); overridable per cron run via the `TTS_URL` env var. |
| `generator.tts.storyCover` | boolean | `false` | Route the story-cover bundle to TTS; on any TTS failure, **fails over** to the incumbent provider. |
| `generator.tts.opinionGate` | boolean | `false` | Route the opinion topic-gate to TTS; on any TTS failure, **fails closed** (all candidates excluded) — never over to another model. |
| `generator.tts.opinionImageBrief` | boolean | `false` | Route the opinion hero image-brief to TTS; on any TTS failure, **fails over** to the incumbent brief call. |

### `image` — image generation

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `image.provider` | enum | `grok-terminal` | One of `grok-terminal` \| `grok` \| `local`. |
| `image.grok.baseUrl` | string | `https://api.x.ai/v1` | xAI API base URL (the `grok` image path). |
| `image.grok.model` | string | `grok-imagine-image-quality` | Model for the `grok` image path. |
| `image.grok.aspectRatio` | string | `1:1` | Requested aspect ratio. |
| `image.grok.resolution` | string | `1k` | Requested resolution. |
| `image.local.url` | string | `http://localhost:8189` | LAN imagegen microservice base URL (the `local` provider). |
| `image.local.style` | string | `base` | Style sent to the LAN service. `base` = prompt-only (deliberately avoids any brand-specific LoRA). |
| `image.grokTerminal.command` | string | `grok` | Executable for the keyless CLI `/imagine` path. |
| `image.grokTerminal.args` | string[] | `[]` | Extra args passed to the CLI. |
| `image.grokTerminal.timeoutMs` | number | `180000` | Per-story image timeout for the CLI path. |
| `image.optimize.enabled` | boolean | `true` | Build-time bandwidth optimization: downscale + WebP re-encode every stored image (all providers; covers stories, ads, articles). Set `false` to store bytes verbatim. |
| `image.optimize.maxEdge` | number | `1280` | Longest-edge cap in px; larger images are downscaled (smaller ones untouched). |
| `image.optimize.quality` | number | `80` | WebP quality (1–100). |

### `storage` — durable image storage

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `storage.provider` | enum | `blob` | One of `blob` \| `local`. |
| `storage.blob.pathPrefix` | string | `images/` | Key prefix for stored objects. |
| `storage.blob.publicBaseUrl` | string | `""` | Public base URL of the Vercel Blob store (`https://<store-id>.public.blob.vercel-storage.com`). Required for real blob use — the preflight aborts if empty. |
| `storage.local.dir` | string | `site/images` | Directory the `local` provider writes image bytes into (inside the deploy artifact). |
| `storage.local.publicBaseUrl` | string | `images` | Relative URL prefix so locally stored images resolve when `site/` is served statically. |

### `render` — static site

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `render.outputDir` | string | `site` | Directory the rendered site is written to (the deploy artifact). |
| `render.secondaryStoryCount` | number | `4` | Number of secondary "rail" stories after the lead on the cover page. |
| `render.timeZone` | string | `UTC` | IANA time zone the masthead dateline + time-of-day edition label are computed in (ADR-0008). Production uses `America/Denver`. |
| `render.siteBaseUrl` | string | `https://www.brickfeed.news` | Absolute site origin (no trailing slash) used to build each per-story landing page's absolute `og:url` and the X share URLs (ADR-0009). Must be `http(s)://…`. |
| `render.analytics` | `"vercel"` \| `"none"` | `none` | Cookieless web-analytics beacon injected before `</body>` on public pages (cover, sections, about, per-story landing pages). `none` keeps the site JS-free. `vercel` injects the Vercel Web Analytics plain-HTML snippet (`/_vercel/insights/script.js`) **and** the Speed Insights beacon (`/_vercel/speed-insights/script.js`, ADR-0012) — both only report once enabled for the project in the Vercel dashboard (Analytics → Enable, Speed Insights → Enable), and 404 harmlessly until then. The `noindex` operator share sheet is never tracked. |
| `render.share.handle` | string | (unset) | Site X (Twitter) handle **without** a leading `@`; feeds `via=` on the per-story + Share-page links and `twitter:site` on landing cards. Omit to emit neither. |
| `render.share.hashtags` | string[] | (unset) | Default hashtags for share links, each **without** a leading `#`. Omit for none. |
| `render.imageOptimization.enabled` | boolean | `true` | Responsive image optimization (ADR-0012). When on (and the Blob `publicBaseUrl` is an absolute origin), story/ad/article `<img>`s get a `srcset` of same-origin `/_vercel/image` AVIF/WebP variants and the render emits a `vercel.json` `images` block allow-listing the Blob host. **Metered on Vercel** — conservative widths/quality keep transformations within the Pro allotment. Off → plain `<img src=blobUrl>` and no `images` block. A `local` storage provider (relative base) auto-skips it. |
| `render.imageOptimization.widths` | number[] | `[320,480,640,960,1280]` | Candidate widths for the srcset; each becomes one `/_vercel/image?w=` variant and a `sizes` entry in `vercel.json` (Vercel rejects widths outside this list). |
| `render.imageOptimization.quality` | number (1–100) | `75` | Optimization quality for the `q=` param; also the sole allowed `qualities` entry in `vercel.json`. |

### `deploy`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `deploy.command` | string | `vercel --prod --yes` | Command shelled to publish the site. |
| `deploy.cwd` | string | = `render.outputDir` (`site`) | Working directory the deploy command runs in (where `vercel link` was done). |
| `deploy.enabled` | boolean | `true` | When `false`, the cycle renders but skips deploy (`skipped-disabled`). |

---

## Environment variables

All read only in [../src/secrets.ts](../src/secrets.ts). None are needed for the keyless
default path except the Blob token.

| Variable | Read by | Needed when |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | `getBlobReadWriteToken` — Vercel Blob provider | **Always, with the default `storage.provider: blob`.** The Blob preflight aborts the cycle if it's missing. |
| `XAI_API_KEY` | `getXaiApiKey` — Grok (xAI) generator/image | Only if `generator.provider` or `image.provider` is `grok` (the xAI **API** path). Not needed for `grok-terminal`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `getSubscriptionToken` — subscription generator | Only if `generator.provider` is `claude` (the subscription `claude -p` path). |
| `ANTHROPIC_API_KEY` | `getApiKey` — API-key generator | Reserved for the `apikey` generator (a documented stub; not implemented). |
| `VERCEL_TOKEN` | `getVercelToken` — deploy runner | Only for CI-like/headless deploy. The LAN box normally relies on a one-time `vercel login` and leaves this unset. |
| `TTS_URL` | `getTtsUrl` — TTS local provider | Optional, **non-secret** override of `generator.tts.url` (e.g. set in `cron.env` to repoint a cron cycle). Only consulted when a `generator.tts.*` task flag is enabled. Not a credential — TTS is keyless in prod. |

## Provider selection matrix

Three independent seams. The recommended **keyless** production combination is in bold.

| Seam | Config key | Options | Keyless default | Needs at run time |
| --- | --- | --- | --- | --- |
| Text | `generator.provider` | `grok-terminal`, `grok`, `claude`, `apikey` | **`grok-terminal`** | Nothing (CLI subscription login) |
| Image | `image.provider` | `grok-terminal`, `grok`, `local` | **`grok-terminal`** | Nothing (CLI subscription login) |
| Storage | `storage.provider` | `blob`, `local` | **`blob`** | `BLOB_READ_WRITE_TOKEN` + `storage.blob.publicBaseUrl` |

- **`grok-terminal`** (text & image) authenticates via a one-time interactive `grok` CLI
  login and reads no API key at run time. This is the live production path.
- **`grok`** uses the xAI HTTP API and requires `XAI_API_KEY`.
- **`claude`** uses the Claude subscription CLI (`claude -p --output-format json`) and
  authenticates via the CLI's stored subscription login (or `CLAUDE_CODE_OAUTH_TOKEN`).
  It is invoked **without** `--bare`: minimal mode skips loading that login, so `claude -p
  --bare` returns "Not logged in" and every story comes back null.
- **`local`** (image) posts to a LAN imagegen microservice; no API key, style forced to `base`.
- **`blob`** (storage) is the durable default; **`local`** writes bytes into `site/images` so
  they ship inside the static site (handy for a fully self-hosted, keyless setup).

See [INSTALL.md](INSTALL.md) for setting these up on an Ubuntu server and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the seams fit into the pipeline.

## Live-checking the `claude` text provider before switching

Before moving text generation from `grok-terminal` to `claude` (Haiku by default) — image
generation stays on Grok — run the opt-in live harness to confirm the real Claude CLI
produces every text artifact:

```
npm run check:claude                          # Haiku (claude-haiku-4-5-20251001)
npm run check:claude -- --model=claude-sonnet-5   # try another model
```

It drives the real `claude -p` CLI (not a mock — so it's kept out of `npm test`) over a
handful of diverse stories and prints each `headline` / `description` / `imagePrompt` /
`category` / `caption` alongside pass/fail checks. It needs the `claude` CLI logged in
(a stored subscription login, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) and
exits non-zero if any story fails to produce all artifacts. A green run is the go-ahead to
set `generator.provider` to `"claude"` and `generator.model` to the Haiku id, leaving
`image.provider` on Grok.

> **Gotcha (fixed):** the subscription runner must invoke `claude -p` **without** `--bare`.
> Minimal mode skips loading the stored subscription login, so `claude -p --bare` returns
> `is_error:true` "Not logged in" and every story comes back null even on an authenticated
> box. See `src/generator/subscription.ts` (`buildClaudeArgs`).
