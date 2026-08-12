# Install & run it yourself

This guide gets brickfeed-news running on your own machine and (optionally) scheduled to publish on
its own. It's an honest walkthrough — the app is a small developer project, so this involves a
terminal, a free Vercel account, and a couple of one-time logins. If you'd rather just *look* at the
result, the quickest win is the live site: **[brickfeed.news](https://www.brickfeed.news)**.

The app is **one-shot**: you (or a scheduler) fire a "cycle", it fetches the news, makes the pictures,
builds the site, publishes it, and exits. There's no server humming in the background.

---

## Which computer?

- **Linux (Ubuntu)** — the primary, best-tested home. Follow everything below as-is.
- **macOS** — the core works fine (`npm install`, `npm run cycle`, `npm test`). A couple of the
  *scheduling* helpers are Linux-only; see [the macOS notes](#macos-notes).
- **Windows** — run it inside **WSL2 (Ubuntu)** and then follow the Linux steps. See
  [the Windows notes](#windows-notes). (Plain PowerShell can run the app, but not the cron wrapper.)

You do **not** need a fancy machine or a graphics card. The default setup sends the writing and the
pictures out to keyless AI command-line tools; your computer just orchestrates.

---

## The simplest path (what this guide sets up)

- **Writing** → the keyless **`claude` CLI** (Anthropic's Haiku model), matching the live site.
- **Pictures** → the keyless **`grok` CLI** (drives image generation from your subscription login).
- **Storage** → **Vercel Blob** (a free bucket the images live in).
- **Publishing** → the **Vercel** command-line tool.

Both AI tools authenticate with a one-time subscription login — **no API keys to manage**. (Advanced
alternatives — an xAI/Anthropic API key, or self-hosting the AI on your own GPU — are covered in
[CONFIGURATION.md](CONFIGURATION.md) and [the building-blocks section of the README](../README.md).)

---

## 1. System prerequisites

You need **Node.js 22 or newer** and **git**.

**Linux (Ubuntu):**

```bash
sudo apt-get update
sudo apt-get install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # v22.x or newer
```

**macOS** (with [Homebrew](https://brew.sh)):

```bash
brew install node git
node --version    # v22.x or newer
```

**Windows:** install WSL2 first (see [Windows notes](#windows-notes)), then use the Linux commands
above inside your Ubuntu shell.

`tsx` (which runs the TypeScript directly) is a project dependency — it installs with `npm install`,
no global setup needed.

## 2. One-time accounts & logins

These are interactive, human-only steps. Do them once; don't try to automate them.

### a. The `grok` CLI — pictures

Install the agentic `grok` CLI and log in with your subscription. At run time the app drives it
headlessly to make each toy-brick image; no API key is read. Verify it runs without prompting for
auth before continuing.

### b. The `claude` CLI — writing

Install the `claude` CLI and log it in (run `claude setup-token`, or use a stored subscription
login). This is what the live site uses to write headlines, descriptions, and columns (Haiku).

### c. The Vercel CLI — publishing

```bash
npm install -g vercel   # use sudo on Linux if needed
vercel login
```

You'll link the project to a folder in step 4 (after cloning).

### d. A Vercel Blob store — where images live

In the [Vercel dashboard](https://vercel.com), create a **Blob store** for the project. Capture two
things:

- its **public base URL** (looks like `https://<store-id>.public.blob.vercel-storage.com`) — goes in
  `config.json` under `storage.blob.publicBaseUrl`;
- a **read/write token** (`vercel_blob_rw_…`) — goes in the environment as `BLOB_READ_WRITE_TOKEN`
  (never in the config file, never committed).

## 3. Clone & install

```bash
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
- **`storage.blob.publicBaseUrl`** — the Blob store public base URL from step 2d (replace the
  `https://your-store-id.public.blob.vercel-storage.com` placeholder).
- Confirm **`generator.provider`** is `"claude"`, **`image.provider`** is `"grok-terminal"`, and
  **`storage.provider`** is `"blob"`.

Then link Vercel to the publish folder (which defaults to `site/`):

```bash
cd site
vercel link          # select/create the "brickfeed" project
cd ..
```

This writes `site/.vercel/project.json` (git-ignored). Every field is documented in
[CONFIGURATION.md](CONFIGURATION.md); anything you omit gets a sensible default, so a minimal config
is fine.

## 5. Secrets / environment

The app reads secrets **only** from environment variables (in [../src/secrets.ts](../src/secrets.ts))
and does **not** load a `.env` file. For this setup, the one variable you need is the Blob token:

```bash
# ~/.profile (or ~/.zshrc on macOS) — persists for your interactive shells
export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_xxxxxxxx"
```

Never paste a real token into a file that gets committed. `config.json`, `site/`, and the token all
stay out of git.

## 6. First run

Work up from safe to live:

```bash
# 1. Prove the build/tests are healthy (fully mocked, no network):
npm test

# 2. Dry run — logs intended actions, changes nothing, calls no AI:
npm run cycle -- --dry-run

# 3. Real pipeline but no publish — makes images, builds the site into site/,
#    but does NOT push live. Open site/index.html in a browser to inspect:
npm run cycle -- --no-deploy

# 4. Full cycle — includes the live publish:
npm run cycle
```

What to expect:

- A **storage preflight** runs first. If the Blob token or public base URL is missing, the cycle
  stops immediately with a clear message — before it spends anything on image generation.
- A full run prints a per-stage summary (`ingest … / generate … / image … / render … / deploy …`).
  Only stories whose image actually lands in storage get published.

## 7. Schedule it (optional)

To keep publishing on its own, run [../scripts/cycle.sh](../scripts/cycle.sh) on a timer. It's a
wrapper that takes a **non-blocking lock** so an overlapping tick *skips* rather than colliding with a
still-running cycle, logs to `cycle.log`, and prints a heartbeat so a long quiet stage isn't mistaken
for a hang.

**Linux / macOS with cron** — edit the crontab with `crontab -e` and add (use an **absolute** path):

```cron
# Run a cycle every 30 minutes:
*/30 * * * *  /home/kris/brickfeed-news/scripts/cycle.sh
```

> **Cron doesn't read your shell profile,** so it won't see `BLOB_READ_WRITE_TOKEN`. **Recommended:**
> put the token in a git-ignored `cron.env` file at the repo root
> (`BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…`) — `scripts/cycle.sh` sources it automatically. (Or set it
> inline at the top of the crontab.)

Optional overrides the wrapper honors: `BRICKFEED_LOCK` (lock file path), `BRICKFEED_LOG` (log file
path), `BRICKFEED_HEARTBEAT_SECS` (heartbeat interval, default `30`).

Watch progress with `tail -f cycle.log`.

## 8. Make it yours: ads & articles

Beyond the auto-generated feed stories, you can publish two kinds of hand-authored content by dropping
files into `assets/` — no code, no restart:

- **Banner ads** — an image + a one-line click-through URL under `assets/ads/`. See [ADS.md](ADS.md).
- **Locally hosted articles** — an image + a small markdown file under `assets/articles/`, which
  become real on-site stories with their own page. See [ARTICLES.md](ARTICLES.md).

The next cycle (or a manual `npm run render`) picks them up. A malformed or half-present pair is
silently skipped, never breaking the cycle.

---

## macOS notes

The core app runs fine on macOS. Two things differ, and both only matter if you use the scheduler in
step 7:

- **`flock`** (the overlap lock in `scripts/cycle.sh`) isn't built in. Install it with
  `brew install flock`.
- **`notify-send`** (Linux desktop notifications) and **`systemctl`** (used only by the optional
  self-hosted text service) don't exist on macOS. The app treats both as best-effort and simply skips
  them — nothing breaks.

You can schedule with `cron` as shown above, or with a `launchd` agent if you prefer the native macOS
scheduler.

## Windows notes

The scheduler wrapper is a bash script that uses Linux tools, so the smooth path on Windows is
**WSL2**:

1. Install WSL2 with Ubuntu: open PowerShell as admin and run `wsl --install`, then reboot and finish
   the Ubuntu first-run setup. (Microsoft's guide:
   <https://learn.microsoft.com/windows/wsl/install>.)
2. Open the **Ubuntu** terminal and follow this guide's **Linux** steps from section 1 onward — inside
   WSL you're effectively on Ubuntu.

(You *can* run `npm run cycle` directly in PowerShell if you install Node for Windows, but the cron
wrapper and scheduling won't work there — WSL2 is the recommended way.)

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| Cycle aborts at `storage-preflight` | For blob: `BLOB_READ_WRITE_TOKEN` (env) and/or `storage.blob.publicBaseUrl` (config) are missing. The message names exactly what to set. |
| Deploy reports `refused-empty` | The render produced no non-empty page / zero publishable records. This guard exists so a bad run can't overwrite the live site — check the generate/image stages produced stories with resolvable images. |
| Cron runs but nothing publishes | Verify the token is set in the *cron* environment (a `cron.env` file is easiest), and that `vercel link` was done inside `site/`. |
| Images 404 on the live site | Confirm `storage.blob.publicBaseUrl` matches the actual Blob store. |
| `grok` or `claude` prompts or fails at run time | Re-check the interactive login (step 2a/2b); a headless run can't authenticate on its own. |
| Overlapping runs | Expected — the lock in `cycle.sh` makes a new tick skip while one is running; it logs "another cycle holds the lock". |

See [CONFIGURATION.md](CONFIGURATION.md) for the full config/env reference and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pipeline fits together.
