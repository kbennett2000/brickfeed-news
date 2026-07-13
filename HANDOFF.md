# Handoff

## Opinion retention split: opinionMaxAgeHours (branch `feat/opinion-retention-split`)

Implements ADR-0013 decision 5: OPINION records retain for `opinionMaxAgeHours` (config key,
default 168h; absent → 168 in code, NEVER falls back to `maxAgeHours`; present-but-invalid
fails loud like every other config key), everything else keeps `maxAgeHours` (still 72 in
prod config — the cycle prompt's "48" was illustrative; `maxAgeHours` untouched).

- **`retentionHoursFor(category, config)` in `src/ageout.ts` is the single retention
  authority.** Both age gates route through it: the real sweep in `ageOut` (per-record
  window, boundary semantics unchanged: kept when `now − lastSeen <= window`, NaN kept)
  and `countStale` in `src/cycle.ts` (dry-run stage line parity). A grep for `3600_000`
  in `src/` must only ever hit those two lines — any third hit is a rogue gate.
- **Render needed NO change**: there is no age gate at render time; "live" IS manifest
  membership after ageout, and `presentSections` derives from presence. A longer opinion
  window is realized entirely by the sweep keeping records longer.
- The pinning test (`test/retention.test.ts`) guards the self-masking failure: under 2/day
  posting an unbranched sweep never empties the section (a fresh piece always masks it)
  while page depth silently caps at ~4 instead of ~14. Do not weaken it.
- `npm run ageout` now logs both windows. `docs/CONFIGURATION.md` documents the key.
  `config.json` (box-local) + `config.example.json` carry `"opinionMaxAgeHours": 168`.
- Verified: 517 tests / 38 files, tsc clean; live-store `npm run render` byte-identical
  before/after (206 stories → 224 files) — behavior-invisible until opinion content exists.
- **Merge order**: PR #51 (delivers the stranded #50 headshots work: it merged into
  `feat/opinion-personas-bench` AFTER that branch was squash-merged to master as #49, so
  it never reached master) → then this branch's PR (based on `feat/opinion-personas-bench`).
  First commit on this branch is the human's five persona voice edits, committed verbatim.

## Opinion headshots: idempotent optimize + publish step (branch `feat/opinion-headshots`)

Implements ADR-0013 decision 8 (+ a dated amendment: 256×256, i.e. ~128 px display at 2×
retina). Stacked on `feat/opinion-personas-bench` (PR #49, unmerged — this cycle needs
`loadPersonas`), so its PR targets that branch, not master.

- `src/headshots.ts` — hash-gated processing: sha256 of each `assets/headshots/<name>.png`
  vs its entry in the derived manifest `data/headshots.json` (`HEADSHOTS_MANIFEST_PATH`, a
  module constant like `ADS_DIR` — deliberately NOT config, per this cycle's "no config"
  scope; read degrades to empty, write is tmp+rename, same contract as `manifest.ts`).
  Changed/new sources are center-cropped square to 256×256 (`cropSquareAvatar` in
  `src/image/optimize.ts`, lossless PNG intermediate, null on undecodable input) and
  published via plain `storage.put("headshots/<name>", …)` — the SAME
  `withImageOptimization` chokepoint story images use performs the single WebP-q80 encode,
  landing at blob key `images/headshots/<name>.webp` (deterministic overwrite). Entry shape:
  `{ persona, sourceHash, avatarUrl, processedAt }`.
- Tolerance (ads/articles semantics, never throws): missing PNG → warn + `missing`;
  undecodable → `failed`; upload null → `failed`; in every case any EXISTING entry is
  preserved (the live avatar keeps rendering; a hash mismatch persists so the next run
  retries). Manifest written only when something processed — steady state is six hash
  checks, zero writes.
- Wiring: `npm run headshots [-- --force]` (`src/headshots-cli.ts`, fails loud on storage
  preflight); auto-invoked at the start of `render-cli.ts` and as a tolerant `headshots`
  cycle stage (after storage preflight, before ingest; never sets `ok:false`; dry-run
  prints a "would check persona headshots" line and provably does zero headshot IO).
  `CycleIo` grew a `processHeadshots` boundary (`fakeCycleIo` stubs it).
- **For render (cycle 6): resolve persona → avatarUrl via
  `readHeadshotManifest(HEADSHOTS_MANIFEST_PATH)`; a persona absent from the manifest
  simply has no avatar.**
- Box-verified: first run 6 processed + 6 entries with real Blob URLs; immediate rerun 6
  skipped; `--force` 6 processed; one re-encoded source → exactly 1 processed. Suite: 509
  passing / 37 files (E2E over the real PNGs is `describe.skipIf`-guarded; CI needs no
  assets and no network).
- Known limitations: entries for deleted personas are not pruned (orphan avatars would
  linger in Blob); toggling `image.optimize.enabled` doesn't change `sourceHash`, so a
  format change needs `--force`.
- Found in the working tree (NOT committed by this cycle): human edits to five persona
  worldview sections — left uncommitted for Kris to commit to PR #49.

## Opinion personas: voice assets + bench harness (branch `feat/opinion-personas-bench`)

The six ADR-0013 persona prompt assets now exist under `personas/` — `_shared.md` (the REGISTER +
GUARDRAILS block prepended to every opinion prompt; register decision since the ADR: personas are
over-the-top SELF-caricatures, the joke lands on the author, never on the people in the news) plus
`{alice,bob,edgar,stryker,larry,cynthia}.md`, each with front-matter (`name`, `display_name`,
`byline_blurb`, `selection_bias`) and a voice prompt (worldview / comedy engine / exaggeration
anchor / signature moves / hard rules). **The byline blurbs are human-owned draft copy committed
verbatim — flagged for edit.** No pipeline wiring, no site/config/cron changes, no publishing.

What landed in code:

- `src/personas.ts` — hand-rolled front-matter parser (`parsePersona`, strict: null on missing
  field, non-CATEGORIES `selection_bias` key, or bad weight — typos fail loudly, never launder
  into WORLD) + tolerant `loadPersonas` (log-and-skip, `_`-prefix excluded, front-matter `name`
  must equal the file basename). Mirrors `articles.ts`.
- `src/generator/text.ts` — free-form text seam over the SAME provider abstraction
  (`createTextGenerator(config)`: grok-terminal | claude | grok; transport-only, never-throw →
  null; `apikey`/unknown throws at factory time). Reuses the exported runners/extractors; the
  only existing-src edit was exporting `defaultRunner` in `subscription.ts`. **Next cycle's
  opinion pipeline stage should build on this seam** (nothing in the pipeline imports it yet).
- `scripts/persona-bench.ts` (`npm run bench:personas -- --persona <name> | --all`, plus
  `--fixtures <dir>` | `--recent <n>` | `--provider <p>`) — assembles `_shared` + persona body +
  article blocks, prints each piece with word count. Offline fixtures in `fixtures/opinion-bench/`
  (3 neutral fictional articles). `--recent` synthesizes blocks from `published.json`
  headline/description (the store keeps no article bodies).
- Tests: `test/personas.test.ts` (parser + loader + schema validation of the real committed
  persona files; headshot pairing under `describe.skipIf` since `/assets/` is git-ignored) and
  `test/generator.text.test.ts`. Suite: 484 passing / 36 files.

**Bench voice-read findings** (`--all` over the 3 fixtures, provider claude/Haiku): all six voices
clearly distinguishable and in-register; all deadpan (no in-body bot acknowledgments); all pieces
in the 300–500 word range on both runs. Alice and Bob read equally sharp — no observed political
thumb on the scale. Minor notes for future iteration: Edgar produced only one explicit "and
another thing" digression (spec wants stacks that never resolve), and 5 of 6 personas chose the
same fixture article (the streaming redesign) — topic spread will come from the pipeline's
selection_bias weighting, not the prompt. No persona-file edits were needed this cycle.

Still future per ADR-0013: the opinion pipeline stage (cadence, idempotency, topic gate),
`opinionMaxAgeHours` config, headshot optimize step, and rendering of opinion pieces.

## Opinion section: ADR-0013 + conditional section rendering (branch `feat/opinion-section-scaffold`)

The full Opinion-section design (six disclosed AI persona authors) is recorded as **ADR-0013**
(`docs/adr/0013-opinion-section-architecture.md`): pipeline-stage generation via the existing
`Generator` seam, `personas/*.md` prompt assets with front-matter (`name`, `display_name`,
`byline_blurb`, `selection_bias`; headshots by convention at `assets/headshots/{name}.png`, no
`avatar_seed`), stateless cadence (2/day, fixed pairs, `daysSinceUnixEpoch % 3`, skip-never-backfill),
idempotency key `opinion-{author}-{YYYY-MM-DD}` (UTC), retention via `opinionMaxAgeHours` (default
168, never inherits `maxAgeHours`), three static hand-written disclosure surfaces (page banner,
byline_blurb footer, Twitter Card description **prefix**), topic gate + content guardrails, and
layout reuse with byline-row/footer/banner deltas. **This cycle landed only the UI groundwork** —
personas, generation, headshot processing, config, and cron are all future cycles per the ADR.

What landed in code — **all section rendering is now data-driven** (ADR-0013 decision 9):

- `renderSite` computes `presentSections` once (feed records + live local articles, CATEGORIES
  order) and threads it through `sectionNav`/`footer`/`renderAbout`/`renderCover`/`renderSection`
  (all now take a `sections: readonly Category[]` param). A section with zero published items is
  omitted from the nav, the footer, the sitemap, **and no `<slug>.html` is emitted at all**. The
  two hard-coded `filter((c) => c !== "OPINION")` special-cases are gone; About is a permanent
  trailing nav link. `renderSection`'s empty-state branch is kept defensive-only.
- **Stale-page cleanup (found during verify, not in the plan):** `site/` is written incrementally,
  never wiped — so an omitted section's page from a previous render would linger and deploy. New
  pure helper `staleSectionPages(files)` in `src/render/index.ts`; both writers (`render-cli.ts`
  and `cycle.ts` `defaultCycleIo.writeSite`) now `rm` those files after writing. Verified against
  the real `site/`: the pre-existing stale `opinion.html` was deleted on the next `npm run render`.
- `OPINION` was already in `CATEGORIES` (`src/category.ts`) with a `SECTION_BLURBS` entry — no
  taxonomy change. Opinion appears automatically the day its first piece publishes.
- Tests: 6 render tests updated (per-section emission, nav, empty-section, empty-published, ads
  site-wide, sitemap) + new `describe("renderSite — conditional sections (ADR-0013)")` (Opinion
  visible with a record incl. nav ordering; a live article alone makes a section present; an
  expired article does not; `staleSectionPages`).

Verified: `npx tsc --noEmit` clean; **`npm test` 442 passing, 34 files**; real
`npm run render` (cron.env sourced) → 206 stories, populated sections all render unchanged,
no opinion links anywhere, stale `opinion.html` removed from `site/`.

---

## Switch text generation to Claude/Haiku (images stay on Grok) + the `--bare` fix that unblocks it (branch `fix/claude-bare-not-logged-in`, PR #44)

**Text** generation now runs on the **`claude` provider with Haiku** (`claude-haiku-4-5-20251001`);
**image** generation stays on **Grok** (`grok-terminal`). Grok is images-only now. Recorded as
**ADR-0011**. The switch is applied to the live (git-ignored) `config.json` and mirrored in the
committed `config.example.json`; the code-level default when the provider is omitted stays
`grok-terminal` (ADR-0007). Verified end-to-end: real `config.json` → `createGenerator` selects
`SubscriptionGenerator` → Haiku returns all five artifacts (~26s cold). CLAUDE.md's runtime-topology
/ pipeline / pluggable-generator notes updated to reflect the split.

> Operator note (from the switch request): the Grok subscription can run out of credit — when it
> does, **image** generation fails and stories sit unpublished until an image lands. Text (Claude)
> is unaffected. `image.provider` intentionally has no `claude` option.

This branch also carries the bug fix that made the switch possible at all:

Groundwork for moving **text** generation from `grok-terminal` to `claude` (Haiku by default) —
**image generation stays on Grok**. This **fixes a real bug that was blocking the switch entirely**
and lands the opt-in live test the operator asked for.

**The bug (fixed).** `src/generator/subscription.ts` spawned `claude -p --bare --output-format json`.
`--bare` ("minimal mode: skip hooks, LSP, plugin") also skips loading the stored subscription login,
so headless `claude -p --bare` returns `is_error:true` "Not logged in · Please run /login" **even on
a fully authenticated box** — `SubscriptionGenerator` then returns null for every story. So switching
`generator.provider: "claude"` would have silently left every story pending. (My previous handoff
wrongly blamed the environment / missing `CLAUDE_CODE_OAUTH_TOKEN`; that was wrong — the box is
authenticated; our own `--bare` flag was the problem. The working `photo-wrangler` app invokes
headless `claude` without `--bare`.)

- **Fix:** dropped `--bare`; the runner now uses `["-p", "--output-format", "json", "--model", m]`,
  extracted into an exported `buildClaudeArgs(model)` with a regression test asserting `--bare` is
  never present (`test/generator.subscription.test.ts`).
- **New `scripts/check-claude-generator.ts`** (`npm run check:claude`, `-- --model=<id>` to override;
  default `claude-haiku-4-5-20251001`). Drives the **real** `claude -p` CLI through the production
  `SubscriptionGenerator` (no injected runner) over 5 diverse stories, prints each of the five
  artifacts (headline/description/imagePrompt/category/caption) with HARD checks (non-null, all four
  text fields non-empty, category in taxonomy) and SOFT quality warnings (verbatim-title, word
  counts). Exits non-zero on any hard failure. Never greps for trademark strings (CLAUDE.md
  guardrail) — brand/text-in-scene review is left to the eyeball.
- **Not wired into `npm test`** (stays mock-first/offline). `scripts` is in `tsconfig.json` `include`
  so the harness is typechecked; usage + the `--bare` gotcha noted in `docs/CONFIGURATION.md`.
- The remaining switch is now genuinely config-only: the `claude` provider shares the exact prompt
  (`src/prompt.ts`) and parser (`src/generator/parse.ts`) with `grok-terminal`. Set
  `generator.provider: "claude"` + `generator.model` to the Haiku id, leaving `image.provider` on Grok.

Verified on the box (authenticated `claude` CLI): `npx tsc --noEmit` clean; **`npm test` 401 passing,
32 files** (2 new `buildClaudeArgs` tests); **`npm run check:claude` → 5/5 passed · 0 quality
warnings** with genuinely good Haiku output (original rewrites, correct categories, brick-diorama
image prompts, ~14–22s/story warm). Operator step: eyeball that output, then flip the config.

---

## Share sheet: LinkedIn button + section split + filtering, and `Sport`→`Sports` (branch `feat/share-linkedin-sections-filter`)

Operator-facing changes to the private `share.html` worksheet plus a taxonomy rename. All in the
pure render core (`src/render/*`) + data/tests/docs; no pipeline or config changes.

1. **"Post to LinkedIn" button per row.** New `buildLinkedInIntentUrl` in `format.ts` →
   `https://www.linkedin.com/feed/?shareActive=true&text=<headline>%0A%0A<pageUrl>`. Prefills the
   post body like X; LinkedIn resolves the landing page's OG tags to auto-attach the brick-image
   card (best-effort). No 280 budget / no via/hashtags — deliberately simpler than the X builder.
   Each row now renders both buttons inside a `.sharesheet__actions` group.
2. **Local articles pinned to their own top section.** `renderShareSheet` partitions rows by
   `view.local` into a **"Local articles"** section (top) then **"From the feed"**; empty sections
   (and their headings) are omitted. Ordering is now independent of push order in `index.ts` — no
   `index.ts` change.
3. **Client-side section filter.** A chip bar (`All` + one chip per category present, in
   `CATEGORIES` order, `titleCase` labels) with a small vanilla-JS IIFE that shows/hides rows by
   `data-category` and hides any section left empty. Fine on this `noindex` operator-only page.
4. **`Sport` → `Sports`.** Enum value `SPORT`→`SPORTS` in `src/category.ts` (label, `sports.html`
   slug, nav, prompt all derive from it); `SECTION_BLURBS` key renamed; migrated the 40 stored
   `"category": "SPORT"` values in `data/manifest.json` (25) + `data/published.json` (15) so
   `normalizeCategory` doesn't silently remap them to WORLD. Old `sport.html` bookmarks 404 (fine
   for a rotating hobby site; no redirect). Docs updated (`docs/ARTICLES.md`, this file).

Verified: `npx tsc --noEmit` clean; **`npm test` 399 passing, 32 files**; local `npm run render`
emits `share.html` with 140 X + 140 LinkedIn links, 8 filter chips (incl. SPORTS), and `sports.html`.
Deploy: per operator request this branch is merged to `master` (Vercel auto-deploys `brickfeed.news`).

---

## Docs refresh — ads + articles + stale-doc cleanup (branch `docs/refresh-ads-articles`)

Current state as of this entry:

- **Live** on **https://www.brickfeed.news** (the old `brickfeed-teal.vercel.app` URL in these
  docs was stale and has been corrected). Deploys are direct `vercel --prod --yes` from the box
  (ADR-0006), not git-push-triggered.
- **ADR-0009** (per-story `s/<id>.html` landing pages + X share sheet) is landed/Accepted.
- **ADR-0010 — locally hosted articles** is landed (branch `feat/local-articles`, PR #40):
  on-site original stories from `assets/articles/` with section, cover/section rank, expiry, and
  a hosted body page reusing `s/<id>.html`. Adds the `marked` dependency. Documented in
  `docs/ARTICLES.md`.
- **Banner ads** (`src/ads.ts`, `assets/ads/`) are now documented in the new `docs/ADS.md` (they
  had no docs before).
- Reference docs reconciled to the code: `docs/CONFIGURATION.md` (added `render.timeZone`/
  `siteBaseUrl`/`share`, fixed `maxStoriesPerCycle` default 20→40), `docs/ARCHITECTURE.md`
  (added `ads.ts`/`articles.ts`/`render/markdown.ts`, per-story + share output, 393-test count),
  `README.md` (URL, `marked` dep, docs index), `CLAUDE.md` (keyless `grok-terminal` default,
  CLI-direct deploy). Suite: **393 tests, 32 files**.

---

## Per-story landing pages + assisted-manual X share sheet (ADR-0009, PR pending)

Sharing a brickfeed story on X used to paste the **outbound source URL**, so X rendered the
*publisher's* OG card, not our brick art. This slice adds, entirely inside the pure render
core (`src/render/*`) + the two thin writers:

1. **Per-story landing pages at `site/s/<id>.html`.** `renderSite` now emits one
   social-card page per publishable record. `<head>` (new `cardMeta` in `templates.ts`):
   `twitter:card=summary_large_image`, `og:type=article`, `og:title`/`og:description`,
   `og:image`+`twitter:image`=the record's absolute Blob `imageUrl`, `og:url`=the page's own
   ABSOLUTE URL, and `twitter:site` **only** when a handle is configured. `<body>`: the brick
   image (shared `figure`), kicker, headline, dek, caption + `/ BRICKFEED STUDIO`, and a
   prominent outbound link to the source. Self-contained (lives in `s/`): a brand header, not
   the root-relative masthead/nav/footer, and `../styles.css` via a new `pageShell`
   `assetPrefix` hook.
2. **Assisted-manual share sheet at `site/share.html`** (new `renderShareSheet`): one row
   per story = thumb + headline + a **"Post to X"** button whose href is the X Web Intent
   URL (`buildXIntentUrl` in `format.ts`, built with `URLSearchParams`): `text`=headline,
   `url`=absolute landing URL, `hashtags`/`via` only when configured. Headline is
   length-budgeted under 280 (23 for the t.co URL) and truncated with `…`. `<meta robots
   noindex>`; NOT linked from the nav/footer. $0, no API, no scheduler — a human clicks.

- **Config (`src/config.ts`):** NEW `render.siteBaseUrl` (absolute, no trailing slash,
  validated; default `https://www.brickfeed.news`) — the only way to build absolute
  `og:url` + share URLs. NEW optional `render.share { handle?, hashtags? }` (handle stored
  without `@`, hashtags without `#`). `config.example.json`, `test/helpers.ts` `makeConfig`,
  `test/config.test.ts` updated.
- **Writers:** `defaultCycleIo.writeSite` (`cycle.ts`) + the `render-cli.ts` loop now
  `mkdir` each file's parent (the `s/<id>.html` keys carry a subdir); both threaded
  `siteBaseUrl` + `share`.
- Tests **365 passing** (+57). Gates clean: `tsc --noEmit`; `process.env` only in
  `secrets.ts`; `grep -rin lego src config.example.json` empty. Repo stays text-only —
  landing/share pages are gitignored `site/` artifacts; templates/CSS are committed source.
- **Verified end-to-end:** drove `renderSite` over the real 100-record `data/published.json`
  → 112 files (100 landing + `share.html` + the 11 chrome pages). A landing page's `<head>`
  carries the real Blob `og:image`, absolute `og:url`, `@brickfeednews` twitter:site, and
  `../styles.css`; `share.html` has 100 fully-encoded intent links (text+url+hashtags+via,
  `&amp;`-escaped), `noindex`, and is linked nowhere in the nav/footer (0 references).
- **NOTE (no tracking issue):** this cycle was driven directly (no open `instructions`
  issue), so there was nothing to comment/relabel — only the PR.
- **Box action:** set `render.siteBaseUrl` to the real live origin in the box `config.json`
  (it defaults to `https://www.brickfeed.news`); optionally set `render.share.handle` /
  `render.share.hashtags` to enable `via`/hashtags + `twitter:site`.

## brickfeed is LIVE on real Vercel Blob — image-existence gate + fail-loud preflight (issue #28, merged as PR #29 → master, commit 70c7528)

> **Current state (2026-07-10):** the image-existence-gate work below is merged to `master`
> (commit `70c7528`). Two docs/chrome follow-ups are in review as PRs, not yet merged:
> PR #30 (`chore/footer-tagline-and-dead-links`) replaces the Latin masthead/footer motto with
> the plain-English tagline "All the stories, brick by brick" and drops the dead footer links;
> and a repo-documentation PR (`docs/repo-documentation`) adds `README.md` +
> `docs/{ARCHITECTURE,INSTALL,CONFIGURATION}.md`. History below is unchanged.

**brickfeed now serves a live, fully-imaged page.** Live URL: **https://brickfeed-teal.vercel.app**
(Vercel project `brickfeed`, `site/` linked). Three things landed:

1. **Image-existence gate (no more broken frames).** `isPublishable` only checked that the
   `imageUrl` STRING was present — never that the artifact existed. Result before this cycle:
   **40 of 78 `<img>` were broken** (39 records carried stale local-scheme URLs; only 19 files
   existed). New never-throw **`StorageProvider.exists(id, imageUrl?)`** verifies the artifact the
   render will actually emit — local: `stat` size>0; blob: HEAD the exact stored URL → 200,
   short-circuiting a stale relative/foreign URL. `verifiedPublishableRecords` (src/publish.ts)
   layers it onto the pure field-gate and is the authoritative page source at
   `src/cycle.ts` render (and `writePublished`, threaded a `storage`). No dangling `<img>` renders.
2. **Clear + re-image (owner decision).** `generateImages` reconciles FIRST: any record whose
   `imageUrl` no longer resolves in the CURRENT store is cleared, so it re-images into that store
   (bounded by `maxStoriesPerCycle`). Heals provider switches (local→blob) and deleted/zero files.
3. **Deterministic, fail-loud, non-interactive preflight.** New **`StorageProvider.preflight()`**
   (a provider method — colocated with the provider, keeps the cycle tests hermetic) runs ONCE at
   the top of `runCycle`. Blob requires BOTH `BLOB_READ_WRITE_TOKEN` (env) and
   `storage.blob.publicBaseUrl` (config); local requires a writable dir. On failure the cycle
   ABORTS before ingest/generate with a single actionable stderr message + non-zero exit — never
   pays for images it can't store, never prompts. The old advisory warn in `createStorageProvider`
   was removed (superseded). `src/storage/index.ts` no longer reads env.

**Files:** `src/types.ts` (StorageProvider gains `exists`+`preflight`; `StorageFs` gains `stat`;
`StorageHttpRunner` method adds `"HEAD"`; `CycleIo.writePublished` gains optional `storage`),
`src/storage/{blob,local,index}.ts`, `src/publish.ts`, `src/image.ts`, `src/cycle.ts`,
`src/{image,ageout}-cli.ts`, plus test helpers + new tests. **Tests 308 passing (+20).** Gates
clean (`process.env` only in `secrets.ts`; no lego; `tsc --noEmit` clean).

**PROVEN end-to-end (not mocks):**
- **token UNSET →** `npm run cycle` aborts at `storage-preflight` with the exact fix message,
  exit 1, zero prompts, no generation.
- **token SET →** real keyless cycle (grok-terminal generation, no generation API keys):
  `ingest 12 new`, `generate 12`, `image: recleared 39 stale refs → 20 stored to real Blob, 0 failed`,
  `render 20 publishable`, `deploy: deployed (exit 0)` via `vercel --prod --yes` — **zero prompts**.
- **live site:** every `<img>` across all 9 pages resolves — **40/40 → 200 with non-zero bytes,
  0 broken** (images are honest `.jpg` on the Blob CDN). Was 40 broken of 78.

**Box config (gitignored, on-box):** `storage` block set to `provider:"blob"`,
`blob.publicBaseUrl:"https://7fjkp0rhcwadfro9.public.blob.vercel-storage.com"` (local block kept).
**A real run needs only `BLOB_READ_WRITE_TOKEN` in env** (the `vercel_blob_rw_…` secret — never
committed; put it in the box shell profile / cron env). `site/.vercel` links to the `brickfeed`
project; `vercel` is authenticated as `kbennett2000` (`vercel login` done). `vercel --prod --yes`
+ stdin-ignored deploy runner = non-interactive.

## Local storage now writes images INTO site/ with a resolving URL (issue #26, PR pending)

**Bug:** with `storage.provider=local`, a keyless run produced a `site/` where every `<img>` was
broken. Root causes: (1) the local default `dir` was `data/blob` — git-ignored and *outside* the
`site/` deploy artifact — with an absolute `http://localhost:8189/blob` `publicBaseUrl` that
doesn't resolve when Vercel serves `site/` statically (render emits `imageUrl` verbatim as the
`<img src>`); (2) the image stage hardcoded `image/png`, but grok emits **JPEG**, so files carried
the wrong extension; (3) `local.delete()` / `blob.delete()` reconstructed a hardcoded `.png` name,
so age-out couldn't remove a `.jpg` — orphaned artifacts.

**Fix:**
- **`src/config.ts` + `config.example.json`** — local defaults now `dir: "site/images"`,
  `publicBaseUrl: "images"`. `put` returns the RELATIVE URL `images/<id>.<ext>` — exactly what
  render emits and what resolves under the served site root. Images ship inside `site/`, so
  `vercel` (cwd `site/`) uploads them with the pages.
- **`src/image.ts`** — new `detectImageContentType(bytes)` sniffs JPEG/PNG/WebP magic bytes and
  passes the REAL content-type to `storage.put`, so the stored extension is honest (grok → `.jpg`).
- **`src/storage/local.ts` + `src/storage/blob.ts`** — `delete(id)` (which only gets the id) now
  targets every extension `put` can produce (`IMAGE_FILE_EXTENSIONS = .png/.jpg/.webp`): local
  unlinks each candidate; blob POSTs all candidate URLs in one request. No orphaned `.jpg`.
- Tests **288 passing** (+7): local JPEG round-trip + relative-URL shape, blob multi-ext delete,
  `detectImageContentType` unit tests, JPEG-content-type-through-the-stage. Gates clean
  (`process.env` only in `secrets.ts`; no lego).
- **PROVEN keyless (no API keys), real grok-terminal + local storage, 3 stories** via a scratch
  config through the real `runCycle` path (box `data/`/`site/` untouched): 3 generated + 3 stored
  as **`.jpg`** (256–359 KB, all non-zero) under `site/images/`; rendered `<img src="images/<id>.jpg">`;
  serving `site/` as web root, every image `GET` → **200 image/jpeg** with the exact byte count.
- **Box `config.json` (gitignored, on-box edit):** added a `storage` block set to `provider:
  "local"` with `dir: "site/images"`, `publicBaseUrl: "images"` (was: no storage block → defaulted
  to blob, which needs a token = not keyless). A real `npm run cycle -- --no-deploy` on the box is
  now keyless with zero manual edits.

## grok-terminal pipeline sped up: stage concurrency + cap + logging + timeout (issue #24, PR pending)

The cycle was slow because `generate` then `image` ran one grok CLI call per story, **serially**
(67 + 67). Investigation (measured on the box, keyless): **Chronicle has no faster/warm grok
path** — every Chronicle grok call is a fresh spawn, its grok text is ~116–151s and grok image
~15–20s, and its genuinely-fast images come from a **ComfyUI warm HTTP service**, not grok.
brickfeed's providers already match Chronicle's invocation. Per-call grok time is
**xAI-server-bound** (text ~5–6s, image ~13–15s, ~90% idle waiting), so the model/leader/boot
barely help. **The only material lever is concurrency** — overlapping the idle waits.

- **`src/pool.ts`** — `mapWithConcurrency(items, n, fn)`: bounded pool, results in input order,
  no deps. Unit-tested (`test/pool.test.ts`).
- **`src/generate.ts` / `src/image.ts`** — each stage now selects eligible IDs (in manifest
  order, capped by `opts.limit`), runs them through the pool at `opts.concurrency` (default 1 =
  serial), and applies results **in manifest order** so output is identical to serial
  regardless of finish order. All guarantees preserved (idempotency, all-or-nothing,
  never-throw, limit-as-attempt-cap). Per-story progress via optional `deps.log`
  (`generate 3/20 <id>: ok (5.1s)` / `… pending`).
- **Config** (`src/config.ts`, `config.example.json`) — `concurrency` (default **4**),
  `maxStoriesPerCycle` (default **20**, the per-cycle cap, reuses `opts.limit`), and optional
  `grokTerminal.timeoutMs` (per-call SIGKILL budget; defaults 120s text / 180s image, down from
  180/240). `cycle.ts` threads `{limit: maxStoriesPerCycle, concurrency}` + `log` into both
  stages; factories pass `timeoutMs` to the providers.
- Provider/runner INTERFACES unchanged except an added **optional** `timeoutMs` on the runner
  arg and `log` on the deps — all injected-runner tests hold. Tests **281 passing** (+15).
  Gates clean (`process.env` only in `secrets.ts`; no lego).
- **MEASURED, keyless (no API keys), real grok-terminal + local storage, 6 stories:**
  serial (c=1) **138.6s** (generate 55.0s + image 83.6s, 23.1s/story) → concurrent (c=4)
  **48.4s** (generate 15.1s + image 33.3s, 8.1s/story) = **2.86× faster**, 6/6 generated + 6/6
  stored, valid 340–400 KB images. A full 67-story run approaches ~4×.
- **Follow-up (noted, not done):** incremental per-story manifest persistence would make a long
  concurrent image run crash-resilient (today the stage persists once at the end).

## Box config migrated to keyless grok-terminal (issue #22, PR pending)

The box `config.json` (gitignored — not in the repo) predated the grok-terminal rename and did
NOT use the keyless path. Migrated in place, exactly two changes, everything else untouched:

- `generator.provider`: `"subscription"` → `"grok-terminal"` (was aliasing to the `claude`
  path, not keyless).
- added `"image": { "provider": "grok-terminal" }` (was absent → falling back to a default).

Storage was left untouched per the owner's decision: it defaults to Vercel **Blob**, which
needs `BLOB_READ_WRITE_TOKEN` (an env secret the owner sets), not config.

**Verified with the real box config, keyless** (`grok` CLI subscription login; `XAI_API_KEY`,
`ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN` all unset). Ran `npm run cycle -- --no-deploy`
against the box's grok-terminal + Blob setup, bounded to 2 stories via a local feed + scratch
manifest/site paths (so the live Google-News feed couldn't re-flood the manifest and the box's
real `data/`/`site/` were never touched — the real 67-story manifest was backed up and restored
untouched). Result:

```
warning: BLOB_READ_WRITE_TOKEN is not set; Blob storage will skip every story …
  • ingest:   2 new, 0 known
  • generate: 2 generated, 0 skipped, 0 pending      ← keyless grok-terminal TEXT works
  • image:    0 stored, 0 skipped, 2 failed          ← grok-terminal generated bytes; Blob
                                                        rejected the store (no token)
  • render:   0 publishable → 10 files
  • deploy:   skipped-flag        (exit 0)
```

Takeaways:
- **The keyless generation path is now the effective one.** `generate: 2` with **no
  `XAI_API_KEY` warning anywhere** — both text and image route through the subscription `grok`
  CLI, no API key. The provider-fallback bug is fixed on the box.
- **The only remaining gap to a fully-populated run is storage.** `image: 2 failed` is not a
  grok failure — grok-terminal generated the image bytes; `storage.put` (Blob) returned null
  because `BLOB_READ_WRITE_TOKEN` is unset (the warning names it). With `0` stored images,
  nothing is publishable, so `render` writes the site chrome but `0` stories.
- **To get `image stored > 0` + a populated `site/`:** set `BLOB_READ_WRITE_TOKEN` (and
  `storage.blob.publicBaseUrl`) in the box env — then a real cycle stores to Blob and publishes.
  (Prior cycle #20/#21 already proved the full pipeline end-to-end keyless with local storage:
  generate 2, **image stored 2**, render 2 publishable, valid images. Blob is the same
  `storage.put` seam behind a token.)

`config.json` stays gitignored (secrets/URLs never committed), so this HANDOFF note is the
committed record; the config edit itself is a box-local action.

## keyless grok-terminal is now the real default (issue #20, PR #21 merged)

The prod-keyless promise (ADR-0006 #7) was not actually in effect, and the grok-terminal
providers were built against contracts the real `grok` CLI does not honor. All three fixed
and **proven live, keyless** (no `XAI_API_KEY`, subscription CLI only):

- **Defaults flipped to keyless.** `DEFAULT_PROVIDER` and `DEFAULT_IMAGE_PROVIDER` are now
  `"grok-terminal"` (were `"grok"`, the xAI API-key paths); `config.example.json` matches. A
  fresh/legacy config resolves to the keyless path and never demands `XAI_API_KEY`. The
  `XAI_API_KEY` warning lives only on the API-key `grok` branch, which is no longer the
  default — so the keyless path is silent.
- **grok-terminal TEXT rebuilt** (`src/generator/grokTerminal.ts`). The real `grok` is an
  agentic *coding* CLI: it needs the prompt as the `-p <prompt>` value + `--output-format
  json` (NOT stdin) and returns a `{ "text": ..., "sessionId": ... }` envelope. New
  `extractGrokText` unwraps `.text`, then the shared `parseGeneratorOutput` runs. The default
  runner cages grok in a throwaway temp `--cwd` with planning/subagents/web-search off and
  mutating tools denied (Chronicle reference), so a reply can't explore/edit this repo.
- **grok-terminal IMAGE rebuilt** (`src/image/grokTerminal.ts`). Grok Build never prints PNG
  bytes on stdout; `/imagine <prompt>` writes a file under
  `~/.grok/sessions/<enc(cwd)>/<sessionId>/images/` and records its path in
  `chat_history.jsonl`. The default runner drives `/imagine` in a temp dir, locates the file
  (chat-history `path`, then a newest-image salvage scan), reads the bytes, and cleans up both
  the temp cwd and grok's session copy (so a cron cycle doesn't grow `~/.grok` unbounded).
  Exported `findGrokImagePath` / `newestImageUnder` are unit-tested against a fake tree.
- The provider/runner INTERFACES are unchanged (`TerminalTextRunner` → `{stdout,code}`,
  `TerminalImageRunner` → `{bytes,code}`), so all injected-runner tests still hold; the new
  protocol lives in the default runners + the small text-envelope unwrap.
- Tests **266 passing** (+10). Gates clean: `process.env` only in `secrets.ts`; no lego.
- **LIVE KEYLESS PROOF:** ran the real `npm run cycle -- --no-deploy` against a bounded 2-item
  local feed with `generator`/`image` = grok-terminal and local storage, `XAI_API_KEY` unset
  and no API keys present → `generate: 2 generated, 0 pending`, `image: 2 stored, 0 failed`,
  `render: 2 publishable → 10 files`, exit 0. Both stored files are valid 1280×720 images from
  the grok subscription CLI; headlines are original rewrites; categories assigned. Zero
  API-key warnings.
- **Follow-up (not this cycle):** grok emits JPEG, but the storage layer names artifacts
  `<id>.png` / content-type `image/png` (`src/image.ts` + `src/storage/*`). Browsers
  content-sniff so images render, but the extension/Content-Type are cosmetically wrong for a
  real Blob store — worth a small follow-up to derive the type from the bytes.
- **Box action:** the box `config.json` still has the pre-grok-terminal `generator.provider`
  (`"subscription"` → aliases to `claude`) and no `image` block. To run fully keyless, set
  BOTH `generator.provider` and `image.provider` to `"grok-terminal"` (or delete the blocks so
  they default there now). `config.example.json` is the current correct shape.

## Current state
**Slice 8 (publish-cycle orchestrator + CLI-direct Vercel deploy — the FINAL slice)** is
built on branch `slice-8-cycle-orchestrator-deploy` (off `master`, which already has slices
1–7 merged) with an open PR (see issue #16). It sequences the existing modules into one
in-process run and deploys the rendered `site/` from the LAN box via `vercel --prod`. It does
NOT push to git (deploy is CLI-direct, not a git-trigger). ADR: `docs/adr/0006-orchestrator-and-deploy.md`.

Slice 8 — one run = ingest → generate → image+store → ageout → render → deploy:
- `src/cycle.ts` — `runCycle(config, deps, opts)`: pure orchestrator, calls the module
  functions directly, threads the manifest in memory, persists after each mutating stage.
  Story-level failures stay pending + continue; a STAGE hard-failure (a throw) is logged,
  aborts BEFORE deploy, and returns `ok:false` (CLI exits non-zero). Render consumes
  `publishableRecords(manifest)` directly. Boundaries injected via `CycleDeps`
  (clock, fetch, the 3 configured providers, `DeployRunner`, `CycleIo`) — `defaultCycleIo`
  is the real fs impl (delegates to manifest.ts/publish.ts + a mkdir/writeFile loop).
- `src/deploy.ts` — `deploy(config, {files, publishableCount}, {run,log}, {requested})`,
  NEVER-THROW → `DeployResult` (`deployed` | `failed` | `skipped-flag` | `skipped-disabled`
  | `refused-empty`). CRITICAL GUARD: refuses when no `index.html` or 0 publishable records
  (non-fatal, exit 0) so a bad render never nukes the live site. Deploy runs last, only on a
  real render.
- `src/cycle-cli.ts` (`npm run cycle`): wires real deps (fetch, `createGenerator`/
  `createImageProvider`/`createStorageProvider`, the default spawn-based `DeployRunner`,
  `defaultCycleIo`). Flags `--no-deploy` (run all, skip deploy) and `--dry-run` (log intended
  actions, mutate nothing — no providers/network/writes/deploy). Exit non-zero only on a hard
  stage failure; empty-render refusal stays exit 0.
- `scripts/cycle.sh` — wraps `npm run cycle` in `flock -n /tmp/brickfeed.lock`: an overlapping
  cron tick logs "skipping" and exits 0 instead of racing. Logs to a file
  (`$BRICKFEED_LOG`, default `<repo>/cycle.log`), passes through the exit code.
- **Keyless `grok-terminal` providers** (prod = subscription, no API key, for BOTH text +
  image): `src/generator/grokTerminal.ts` + `src/image/grokTerminal.ts` — same never-throw,
  stdin-prompt, injected-subprocess pattern as `claude -p`. Selected by config
  (`generator.provider` / `image.provider` = `"grok-terminal"`), never hardcoded. Text parses
  the model's JSON reply from stdout (shared `parseGeneratorOutput`); image reads raw PNG
  bytes from stdout. Command/args are config (`grokTerminal.command`/`args`, default `grok`).
- Config: NEW `deploy` block `{ command "vercel --prod --yes", cwd = render.outputDir,
  enabled true }` + `generator.grokTerminal` + `image.grokTerminal` in `src/config.ts`
  (`DeployConfig`/`GrokTerminalConfig` + defaults + `validateDeploy`/`validateGrokTerminal`),
  `config.example.json`, `test/helpers.ts` `makeConfig`, `test/config.test.ts`. New secret
  getter `getVercelToken()` (env stays confined to `secrets.ts`).
- Tests: **251 passing** (was 213, +38) — `test/cycle.test.ts` (exact stage order; hard-fail
  aborts before deploy + non-zero; empty-render guard blocks deploy but ok/exit 0;
  `--no-deploy`; `--dry-run` mutates nothing; `deploy.enabled=false`), `test/deploy.test.ts`
  (deployed/failed/runner-throws-swallowed/skips/guard), `test/generator.grokTerminal.test.ts`
  + `test/image.grokTerminal.test.ts` (parse/bytes + never-throw), extended config/factory
  tests. Gates clean: `grep -rn process.env src/` → only `secrets.ts`;
  `grep -rin lego src/ config.example.json` → EMPTY; `tsc --noEmit` clean.
- Verified end-to-end by driving the REAL `npm run cycle` against a scratch config (owner's
  config.json/manifest/network untouched): `--dry-run` logged intended actions and mutated
  nothing; `--no-deploy` ran the full chain (grok-terminal `true` left the pending story
  pending, ageout dropped a stale record, render wrote 10 files, deploy skipped-flag, exit 0);
  a full run had the real `DeployRunner` spawn the deploy command (deployed exit 0);
  `deploy.enabled=false` → skipped-disabled; and two overlapping `scripts/cycle.sh` runs
  confirmed the second SKIPS on the lock.

### One-time HUMAN prerequisites on the box (do NOT automate headless)
- `cd <repo>/site && vercel login && vercel link` once (creates `.vercel` in the deploy cwd;
  or set `deploy.cwd` and link there). The grok CLI logged in via subscription. Set the box
  `config.json` `generator.provider`/`image.provider` to `"grok-terminal"` (the current box
  config.json still says the OLD `"subscription"` — rename to `"claude"` or switch to
  `"grok-terminal"`; `config.example.json` is the correct current shape). For Blob storage:
  `BLOB_READ_WRITE_TOKEN` + `storage.blob.publicBaseUrl`. Optional `VERCEL_TOKEN` only for
  CI-like contexts.

### Crontab (configure the schedule placeholder; absolute path)
```
<SCHEDULE>  /abs/path/to/brickfeed-news/scripts/cycle.sh      # e.g. */30 * * * *
```

---

**Slice 7 (static cover-page render — the FIRST UI slice)** is built on branch
`slice-7-render-cover-page` (off `slice-6-category-caption`) with an open PR (see issue #13).
It consumes `published.json` and emits a static newspaper site — no ingestion/generation/
image/storage changes. **Ends at static HTML openable locally: NO deploy, NO Vercel, NO push
beyond the PR branch** (deploy is the next slice, after a chat).

Slice 7 — `published.json` (newest-first `ManifestRecord[]`) → a static site:
- `src/render/` — a PURE render core (records + clock in → `path→contents` map out, no fs,
  no wall clock): `index.ts` (`renderSite`, `toStoryView`), `templates.ts` (template-literal
  partials — masthead, sticky nav, lead, rail, card, section head, footer, page shell; the
  nav + footer Sections are built by mapping over `CATEGORIES` from `src/category.ts`, the
  single source of truth — never re-listed), `format.ts` (escape + `formatMastheadDate`
  UTC-uppercased + `relativeTime` + `sectionSlug`/`titleCase`/`bylineFor`), `styles.ts`
  (`STYLES` — the chrome CSS as a committed source string, authored from the design tokens).
- Output: `index.html` (cover: masthead + nav + hero(lead + rail of N) + "Across the
  Brickyard" overflow card grid + footer) + one `<slug>.html` per section (nav works with NO
  client JS; filtered by category, active nav underlined) + `styles.css`. No framework, no
  new dep (template literals; the design DSL/React runtime was reference-only).
- Data mapping: kicker = `category`; headline = `headline` (never the raw feed `title`);
  dek = `description`; caption = `caption` + a render-side `/ BRICKFEED STUDIO` credit;
  byline = decorative `By the {Category} Desk`; "ago" = `relativeTime(firstSeen, now)`; each
  card/headline links OUT to the source `url` (`target="_blank" rel="noopener noreferrer"`);
  real `<img src=imageUrl>` degrading to the studded placeholder frame when absent.
  `imagePrompt`/`wrappedPrompt` never rendered.
- Masthead: injected-clock date (`FRIDAY, JULY 10, 2026`), `LATE BRICK EDITION`, motto
  `TOTVS MVNDVS EX LATERIBVS`. English tagline REMOVED; Search/Subscribe/Today's Paper OMITTED.
- Scope: Hero + overflow only. The design's feature / "Most Bricked" / Opinion-strip are a
  noted FOLLOW-ON (need editorial hand-picking / copy we don't generate). Fonts via Google
  Fonts `<link>` (Georgia fallback); self-hosting is a follow-on.
- `src/render-cli.ts` — `npm run render`: loads config → reads `config.publishedPath`
  (missing/invalid → `[]`, not an error) → `renderSite` → writes `config.render.outputDir`.
  Reads no env (secrets gate holds).
- Config: NEW `render` block `{ outputDir "site", secondaryStoryCount 4 }` in `src/config.ts`
  (`RenderConfig` + defaults + `validateRender`), `config.example.json`, `test/helpers.ts`
  `makeConfig`, `test/config.test.ts`.
- Output policy: `site/` is a gitignored BUILD ARTIFACT (deploy slice decides serving);
  chrome lives as committed SOURCE in `src/render/styles.ts`. No binary assets (wordmark is
  type + CSS studs).
- ADR: `docs/adr/0005-render.md` records all of the above.
- Tests: **213 passing** (was 192, +21) — `test/render.test.ts` (lead headline; nav from the
  enum; kickers; caption + `/ BRICKFEED STUDIO`; outbound source links; SEARCH/SUBSCRIBE/
  TODAY'S PAPER + tagline ABSENT; no "lego"; empty → valid empty page; injected-clock date;
  per-section filtering + active nav; HTML escaping) + `test/config.test.ts` render-block
  cases. Both gates clean: `grep -rin lego src/ site/ config.example.json` → EMPTY;
  `grep -rn process.env src/` → only `secrets.ts`. `tsc --noEmit` clean.
- Verified end-to-end: ran `npm run render` over a representative **seeded** `data/published.json`
  (gitignored; 7 on-brand records, one with a data-URI image, the rest exercising placeholder
  frames) → 10 files (cover + 8 sections + styles.css). Structural confirmation: 1 lead + 4
  rail + 2 overflow cards; 1 real `<img>` + 6 placeholders; `world.html` shows only WORLD +
  active nav; `opinion.html` (no stories) → empty state; masthead date/motto/edition present;
  Search/Subscribe/tagline absent. NOTE: no REAL `published.json` exists yet (the live
  manifest has 0 publishable records — generation+images not run live), so the seed stands in
  until the pipeline produces one; a browser-open pass is the owner's to do on merge.

**Branch stacking note:** `slice-7-render-cover-page` is based on `slice-6-category-caption`.
Merge order: 2 → 2c → 3 → 4 → 6 → 7.

---

**Slice 6 (category + caption on the generation contract)** is built on branch
`slice-6-category-caption` (off `slice-4-storage-publish`) with an open PR (see issue #11).
It amends ONLY the generation + manifest/publish shape — no ingestion, image, or storage
changes.

Slice 6 — the Generator normalized output goes from `{headline, description, imagePrompt}`
to `{headline, description, imagePrompt, category, caption}`:
- `src/category.ts` — NEW single source of truth: the fixed 8-section nav
  `CATEGORIES = [WORLD, POLITICS, BUSINESS, TECHNOLOGY, SCIENCE, SPORTS, CULTURE, OPINION]`,
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
