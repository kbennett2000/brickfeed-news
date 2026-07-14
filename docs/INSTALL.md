# Install & run on an Ubuntu server

This guide sets up the brickfeed-news orchestrator on a LAN Ubuntu box and schedules it to
run on a cron. The orchestrator is one-shot: cron fires a cycle, it publishes, and it exits.

The steps below use the fully **keyless** recipe — the `grok-terminal` provider for both text and
image (authenticated by a one-time subscription CLI login) with **Vercel Blob** storage. That path
needs no generation API keys; only a Vercel Blob token, and it matches the library's code-level
defaults, so it's the simplest thing to stand up first.

> **Note — the live site runs text on Claude/Haiku.** Production currently sets
> `generator.provider: "claude"` (Haiku, `claude-haiku-4-5-20251001`) for **text** while keeping
> **images** on keyless `grok-terminal` (ADR-0011). To match production, follow the keyless setup
> below, additionally log the `claude` CLI in (`claude setup-token`, or a stored subscription
> login), and set `generator.provider` to `"claude"` — see
> [CONFIGURATION.md](CONFIGURATION.md) ("Live-checking the `claude` text provider").

For the API-key alternatives (xAI Grok API, Claude API key) and the LAN imagegen option, see
[CONFIGURATION.md](CONFIGURATION.md).

Commands assume Ubuntu 22.04/24.04 and a non-root user (`kris` in the examples). Adjust paths.

---

## 1. System prerequisites

Install Node.js 22+ and git. Using NodeSource:

```bash
sudo apt-get update
sudo apt-get install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # v22.x or newer
```

`tsx` (which runs the TypeScript directly) is a project dev-dependency — it installs with
`npm install` and does **not** need a global install. `flock` (used by the cron wrapper) ships
with `util-linux`, already present on Ubuntu.

## 2. One-time accounts & external CLIs

These are interactive, human-only steps. Do them once on the box; do **not** try to automate
them headlessly.

### a. The `grok` CLI (keyless text + image)

Install the agentic `grok` CLI and log in with your subscription. This is the default provider
for both `generator.provider` and `image.provider`. At run time the pipeline drives it
headlessly (`grok -p … --output-format json` for text, `grok /imagine` for images); no API key
is read. The CLI writes generated images into its own sessions directory
(`~/.grok/sessions/.../images/`), from which the pipeline reads the file back.

Verify the login works before continuing (`grok` should run without prompting for auth).

### b. The Vercel CLI (deploy)

```bash
sudo npm install -g vercel
vercel login
```

The project link must live in the deploy working directory, which defaults to `site/`. Link it
**after** you've cloned the repo (step 3), from inside `site/`:

```bash
cd /home/kris/brickfeed-news/site
vercel link          # select/create the "brickfeed" project
```

This writes `site/.vercel/project.json` (git-ignored). The box then deploys with a
non-interactive `vercel --prod --yes`; you normally do **not** need a `VERCEL_TOKEN` because
the `vercel login` above persists credentials.

### c. A Vercel Blob store (image storage)

In the Vercel dashboard, create a Blob store for the project. Capture two things:

- its **public base URL** (looks like `https://<store-id>.public.blob.vercel-storage.com`) —
  goes in `config.json` under `storage.blob.publicBaseUrl`;
- a **read/write token** (`vercel_blob_rw_…`) — goes in the environment as
  `BLOB_READ_WRITE_TOKEN` (never in config, never committed).

## 3. Clone & install

```bash
cd /home/kris
git clone https://github.com/kbennett2000/brickfeed-news.git
cd brickfeed-news
npm install
```

## 4. Configure

Copy the example config and edit it:

```bash
cp config.example.json config.json
```

`config.json` is git-ignored. At minimum, set:

- **`feedUrls`** — the RSS feed(s) to ingest (the example uses Google News US).
- **`storage.blob.publicBaseUrl`** — the Blob store public base URL from step 2c (replace the
  `https://your-store-id.public.blob.vercel-storage.com` placeholder).
- Confirm **`generator.provider`** and **`image.provider`** are both `"grok-terminal"` and
  **`storage.provider`** is `"blob"` (these are the example defaults).

Every field is documented in [CONFIGURATION.md](CONFIGURATION.md). Fields you omit are filled
with defaults by `validateConfig`, so a minimal config is fine.

## 5. Secrets / environment

The app reads secrets **only** from environment variables (in [../src/secrets.ts](../src/secrets.ts))
and does **not** load a `.env` file. For the keyless default, the one variable you need is the
Vercel Blob token:

```bash
# ~/.profile (or ~/.bashrc) — persists for interactive shells
export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_xxxxxxxx"
```

> Cron does **not** read your shell profile. Export the variable in the cron environment too
> (see step 7), or the Blob preflight will abort the cycle.

Other variables exist for the non-default providers (`XAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`) and for headless deploy (`VERCEL_TOKEN`); none are needed for the keyless
+ `vercel login` path. See the environment table in [CONFIGURATION.md](CONFIGURATION.md).

Never paste a real token into a file that is committed. `config.json`, `site/`, and the tokens
above all stay out of git.

## 6. First run

Work up from safe to live:

```bash
# 1. Prove the build/tests are healthy (fully mocked, no network):
npm test

# 2. Dry run — logs intended actions, mutates nothing, touches no provider:
npm run cycle -- --dry-run

# 3. Real pipeline but no deploy — generates + stores images, renders into site/,
#    but does NOT push to Vercel. Open site/index.html to inspect:
npm run cycle -- --no-deploy

# 4. Full cycle — includes the vercel --prod deploy:
npm run cycle
```

What to expect:

- The **storage preflight** runs first. If `BLOB_READ_WRITE_TOKEN` or
  `storage.blob.publicBaseUrl` is missing, the cycle aborts immediately with a single
  actionable message and a non-zero exit — before it spends anything on image generation.
- A full run logs a per-stage summary (`ingest … / generate … / image … / render … /
  deploy …`). Only records whose image actually resolves in the store are published.

## 7. Schedule with cron

Production runs via [../scripts/cycle.sh](../scripts/cycle.sh) — a wrapper that takes a
**non-blocking `flock`** so an overlapping cron tick *skips* rather than racing a still-running
cycle (image generation can take minutes). It logs to `cycle.log` in the repo root and passes
through the cycle's exit code.

Edit the crontab with `crontab -e` and add (use an **absolute** path):

```cron
# Set the Blob token for the cron environment (cron does not read ~/.profile):
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxxxxxxx

# Run a cycle every 30 minutes:
*/30 * * * *  /home/kris/brickfeed-news/scripts/cycle.sh
```

Optional overrides (environment variables read by the wrapper):

- `BRICKFEED_LOCK` — lock file path (default `/tmp/brickfeed.lock`).
- `BRICKFEED_LOG` — log file path (default `<repo>/cycle.log`).
- `BRICKFEED_HEARTBEAT_SECS` — heartbeat interval, seconds (default `30`); the wrapper prints an
  "still working" line this often so a long, quiet stage isn't mistaken for a hang.

> **Where to put `BLOB_READ_WRITE_TOKEN` for cron.** Two mechanisms work; pick one. (a) Inline in
> the crontab as shown above. (b) **Recommended:** put it in a git-ignored `cron.env` file at the
> repo root (`BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…`) — `scripts/cycle.sh` sources it
> automatically (`set -a; . cron.env`), since cron does not read `~/.profile`. The `cron.env`
> approach keeps the token out of the crontab and centralizes all cron secrets in one file.

Check progress with `tail -f /home/kris/brickfeed-news/cycle.log`.

## 8. Managing local content (ads & articles)

Beyond the auto-generated feed stories, the operator can publish two kinds of hand-authored
content by dropping files into `assets/` (git-ignored; images upload to storage on the next
cycle, exactly like story images):

- **Banner ads** — an image + a one-line click-through URL under `assets/ads/`. See
  [ADS.md](ADS.md).
- **Locally hosted articles** — an image + a structured markdown file under `assets/articles/`,
  which become on-site stories with a section, cover/section rank, expiry, and their own hosted
  page. See [ARTICLES.md](ARTICLES.md).

No config or restart is needed — the next cycle (or a manual `npm run render`) picks them up. A
malformed or half-present pair is silently skipped, never breaking the cycle.

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| Cycle aborts at `storage-preflight` | For blob: `BLOB_READ_WRITE_TOKEN` (env) and/or `storage.blob.publicBaseUrl` (config) are missing. The message names exactly what to set. For local: the target dir isn't writable. |
| Deploy reports `refused-empty` | The render produced no non-empty page / zero publishable records. This guard exists so a bad run can't overwrite the live site — check the generate/image stages produced stories with resolvable images. |
| Cron runs but nothing deploys | Verify the token is set in the *cron* environment (not just your shell), and that `vercel link` was done inside `site/`. |
| Images 404 on the live site | Confirm `storage.blob.publicBaseUrl` matches the actual Blob store; the image-existence gate should prevent publishing unresolvable images, so a mismatch usually means the config URL is wrong. |
| `grok` prompts or fails at run time | Re-check the interactive subscription login (step 2a); the headless run can't authenticate on its own. |
| Overlapping runs | Expected — the `flock` in `cycle.sh` makes a new tick skip while one is running; it logs "another cycle holds the lock". |

See [CONFIGURATION.md](CONFIGURATION.md) for the full config/env reference and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pipeline is put together.
