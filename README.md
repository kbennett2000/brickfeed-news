# brickfeed-news

**brickfeed** pulls stories from a news RSS feed (Google News–style), rewrites each into an
original headline + short description, generates a toy-brick–styled image per story, and
renders a static newspaper-style cover page that links out to the source article. It's a
personal, non-commercial hobby service.

Live: **https://www.brickfeed.news**

> **Legal guardrails (hard rules).** No "LEGO" or LEGO trademarks anywhere — not the name,
> domain, code, prompts, or output. Brick styling is generic ("plastic toy-brick minifigure
> diorama"), never brand-specific. Publisher images are never displayed — every image is our
> own generated art. Headlines and descriptions are original rewrites, never verbatim feed
> text, and every story links to its source.

---

## Architecture at a glance

One run is a single, non-resident cycle (`runCycle` in [src/cycle.ts](src/cycle.ts)). Cron
fires it; there is no long-running process.

```
fetch RSS ──► resolve redirect ──► story id = sha256(resolved URL) ──► drop already-seen
   │
   ▼
for each NEW story:  generate headline + description + image prompt (Claude/Grok)
                     └─► wrap prompt in brick-style language
                     └─► request image ──► store durably (Vercel Blob)
   │
   ▼
age out stories older than the threshold (delete their images for real)
   │
   ▼
keep only records whose image actually resolves  ──► render static site  ──► deploy (vercel --prod)
```

Every stage is idempotent at the story level and never throws for a single bad story (it
stays pending). The manifest is persisted between stages. A story is **never** published
without a resolvable image, and a bad run can never overwrite the live site (the deploy step
refuses an empty render). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full
module map and data flow.

The render also emits a per-story [`s/<id>.html`](docs/adr/0009-per-story-pages-and-x-share.md)
landing page for social sharing (plus a `share.html` X sheet), and folds in two
operator-managed content sources dropped into `assets/`: **banner ads**
([docs/ADS.md](docs/ADS.md)) and **locally hosted articles** — on-site original stories with a
section, rank, and their own hosted page ([docs/ARTICLES.md](docs/ARTICLES.md)).

## Tech stack & conventions

- **TypeScript run directly via `tsx`** — no build step (`tsconfig` is `noEmit`), ES modules.
- **Minimal deps** — two runtime dependencies: `fast-xml-parser` (RSS parsing) and `marked`
  (rendering local-article markdown bodies, [docs/ARTICLES.md](docs/ARTICLES.md)).
- **ADR-first** — significant decisions are recorded in [docs/adr/](docs/adr/) before code.
- **Text-only repo** — the manifest (JSON) and rendered HTML are the only artifacts; images
  live in object storage referenced by URL, never committed (so "delete an image" is a real
  delete and git history stays small).
- **Injectable boundaries, hermetic tests** — every side effect (fetch, generators, image /
  storage providers, deploy subprocess, filesystem) is injected, so `npm test` runs with no
  network, no GPU, and no running services.
- **Secrets via env only** — read in exactly one file, [src/secrets.ts](src/secrets.ts).

## Quick start (development)

```bash
git clone https://github.com/kbennett2000/brickfeed-news.git
cd brickfeed-news
npm install
cp config.example.json config.json     # then edit — see docs/CONFIGURATION.md
npm test                                # vitest, fully mocked; ~393 tests
```

Run the pipeline without deploying (nothing is touched with `--dry-run`; `--no-deploy` runs
every stage but skips the Vercel push so you can inspect `site/`):

```bash
npm run cycle -- --dry-run
npm run cycle -- --no-deploy
```

Each stage can also be run on its own for debugging:

| Script | Command | What it does |
| --- | --- | --- |
| `npm run ingest` | `tsx src/index.ts` | Fetch feeds, resolve links, assign IDs, dedup against the manifest |
| `npm run generate` | `tsx src/generate-cli.ts` | Generate headline/description/prompt/caption for pending stories (`--limit N`) |
| `npm run images` | `tsx src/image-cli.ts` | Generate + store an image for each un-imaged story (`--limit N`) |
| `npm run ageout` | `tsx src/ageout-cli.ts` | Drop stories past `maxAgeHours` and delete their images |
| `npm run render` | `tsx src/render-cli.ts` | Render `published.json` into the static site under `site/` |
| `npm run cycle` | `tsx src/cycle-cli.ts` | The full orchestrator (all stages + deploy). Flags: `--dry-run`, `--no-deploy` |
| `npm test` | `vitest run` | Run the test suite once |
| `npm run test:watch` | `vitest` | Run the test suite in watch mode |

## How it runs in production

The orchestrator runs on a LAN Ubuntu server. Cron invokes
[scripts/cycle.sh](scripts/cycle.sh) — a non-blocking `flock` wrapper so overlapping ticks
skip rather than race — which runs `npm run cycle`. The cycle renders the static site into
`site/` and deploys it with `vercel --prod`, which Vercel serves. The default production path
is **keyless** (the `grok-terminal` provider for both text and image, authenticated by a
subscription CLI login) and needs only a Vercel Blob token in the environment.

Full setup — prerequisites, config, secrets, first run, and the cron schedule — is in
**[docs/INSTALL.md](docs/INSTALL.md)**.

## Configuration & secrets

App settings live in `config.json` (git-ignored; copy [config.example.json](config.example.json)).
It selects the text generator, image provider, and storage backend, plus feed URLs, the
brick-style language, age-out threshold, concurrency, render, and deploy settings. Secrets
(API tokens) are **never** in config — they come from environment variables read only in
[src/secrets.ts](src/secrets.ts). The app does **not** auto-load a `.env` file. See
**[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** for the full field-by-field reference and
the environment-variable table.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — current-state module map, data flow, and invariants.
- **[docs/INSTALL.md](docs/INSTALL.md)** — Ubuntu server install, configuration, first run, and cron scheduling.
- **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** — every `config.json` field and environment variable.
- **[docs/ADS.md](docs/ADS.md)** — authoring the banner ads (drop-in files under `assets/ads/`).
- **[docs/ARTICLES.md](docs/ARTICLES.md)** — authoring locally hosted articles (drop-in files under `assets/articles/`).
- **[docs/adr/](docs/adr/)** — Architecture Decision Records (the *why* behind each decision).
- **[CLAUDE.md](CLAUDE.md)** — how automated cycles operate on this repo and the project contract.
- **[HANDOFF.md](HANDOFF.md)** — running log of recent cycles and current state.
