# CLAUDE.md

<!-- Everything above the PROJECT CONTEXT marker is inherited from project-template.
     Do not edit per-project. Project-specific content is appended below the marker
     by the factory generator from the new-project issue. -->

## How work runs here

- Work is executed one cycle at a time by a headless `claude -p` run — no persistent session, and no human watching the run.
- Each cycle starts fresh. Current state lives in `HANDOFF.md`, the ADRs under `docs/adr/`, and this file — not in remembered conversation. Read them at the start of every cycle.
- End each cycle by updating `HANDOFF.md` so the next cycle can pick up cleanly.

## The cycle contract

**Never pause or wait for a human.** No one is watching the terminal. You must never end by printing a question and stopping — a question that isn't recorded on the issue is lost. Every cycle ends in exactly one of the two terminal states below, then exits.

**Do the work. Don't ask permission.** When files change, you ALWAYS — without asking, every time:
1. Work on a branch, never `master`/`main`.
2. Commit and push.
3. Open a PR for human review/merge.

Committing, pushing, and opening a PR are never optional and never require confirmation. A human reviews and merges the PR; you do not close the issue.

**Decide, don't stall.** If something is uncertain but you can proceed, make the reasonable choice and note it in the PR description. "Should I also do X?" is not a blocker — do the obvious thing or note it and move on. Non-blocking uncertainty never stops a cycle.

**Stopping early is rare and only for true blockers.** Stop only when you are missing information you genuinely cannot proceed without. Stopping means: record the blocker on the issue (the `needs-input` state below) and exit. This is recording, not asking — you never wait for a reply. A destructive or unwalkbackable action (force push, history rewrite, deleting branches/data) counts as a blocker: do not do it; record it and stop.

## End of cycle — always update the issue

You are given the instruction issue number for this cycle (e.g. #1). Before you exit, run exactly one case:

- **Completed** (files changed, PR opened):
  - `gh issue comment <N> --body "PR: <pr-url>"`
  - `gh issue edit <N> --add-label cycle-summary --remove-label instructions`
- **Blocked** (missing info you cannot proceed without):
  - `gh issue comment <N> --body "<the blocker, stated clearly>"`
  - `gh issue edit <N> --add-label needs-input --remove-label instructions`

Every cycle ends in one of these two states, then stops. Never close the issue.

## Conventions

- ADR-first: significant decisions get an ADR in `docs/adr/` before implementation.
- Keep changes small and reviewable.

<!-- ===== PROJECT CONTEXT (appended per repo — do not add content above this line) ===== -->

## Project context

brickfeed-news pulls stories from a news RSS feed (Google News / Drudge-style), rewrites each into an original headline + short description, generates a toy-brick-styled image per story, and renders a static cover page that links out to the source article. It's a personal, non-commercial hobby service.

**Stack:** TypeScript / Node (via `tsx`), built-in `http` + `fetch`, minimal deps (`fast-xml-parser` + `marked`). Static output (HTML under `site/`) is the deploy artifact; the cycle publishes it directly with `vercel --prod --yes` from the box (ADR-0006). `site/` is git-ignored, so a git push does **not** trigger the deploy.

**Runtime topology:** the orchestrator runs on Kris's LAN server (dev PC during development). **Text** generation runs on the **`claude` subscription CLI with Haiku** (`claude-haiku-4-5-20251001`, ADR-0011); **image** generation runs on the **keyless `grok-terminal` provider** (the agentic `grok` CLI driven headlessly, authenticated by a one-time subscription login — ADR-0007). Grok is images-only now. Both are keyless at run time (each CLI carries its own subscription login); no generation API key is read. The generator and image seams are pluggable (see `docs/CONFIGURATION.md`): alternatives include the xAI `grok` API, the Claude subscription CLI, and a `local` LAN imagegen microservice at `http://<devpc>:8189` (`image.provider: local`). Storage defaults to Vercel Blob (needs `BLOB_READ_WRITE_TOKEN`).

**Pipeline (one run):** fetch RSS → canonicalize each story to a stable ID → drop already-seen stories → for each NEW story: generate headline + description + image prompt (text via `claude`/Haiku, ADR-0011), wrap the prompt with configurable brick style language, request the image (via `grok-terminal`), store it durably → age out stories older than a configurable threshold (delete their artifacts for real) → render the static site — folding in banner ads (`docs/ADS.md`) and locally hosted articles (`docs/ARTICLES.md`) from `assets/` — → deploy with `vercel --prod`.

**Test command:** `npm test` (vitest). CI-safe and mock-first: no live network, no running imagegen, no GPU. Mock the RSS fetch, the generator, and the imagegen/storage HTTP calls.

**Conventions:**
- ADR-first: `docs/adr/000N-*.md` is the authoritative contract for each slice. Build in vertical slices, smallest reviewable unit; open a GitHub issue per slice.
- **Story identity is the backbone.** One canonical key per story = hash of the *resolved* article URL (resolve Google redirect links first). Dedup, "is new," and age-out all key off it.
- **Idempotent generation.** A story that already has a generated image is NEVER reprocessed. A story is NEVER published without an image — pending stories sit unpublished until their image lands.
- **Repo stays text-only.** Manifest (JSON) + rendered HTML only. Generated images live in object storage / LAN-served storage, referenced by URL — never committed to git (avoids unbounded history bloat; makes "delete artifact" a real delete).
- **Pluggable generator.** One `Generator` interface, multiple impls selected by config: the keyless subscription CLIs `grok-terminal` (drives the `grok` CLI headlessly) and `claude` (`claude -p --output-format json`, auth via `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`), plus the `grok` xAI API path and an `apikey` Messages-API stub. **Production now runs text on `claude`/Haiku (ADR-0011) and images on keyless `grok-terminal` (ADR-0007)** — no generation API key needed; Grok is images-only. The library's code-level default when the provider is omitted remains `grok-terminal`. See `docs/CONFIGURATION.md` for the full provider matrix.
- **Config:** app settings file-based (`config.json` git-ignored, `config.example.json` committed) — feed URLs, brick style language, age-out threshold, imagegen URL, schedule. Secrets (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`) via env ONLY.
- **Legal guardrails (hard rules):** no "LEGO" or LEGO trademarks anywhere — not the name, domain, code, prompts, or output. Brick style is generic ("plastic toy-brick minifigure diorama"), never LEGO-specific. Never display publishers' images — every image is our own generated art. Headlines/descriptions are original rewrites, never verbatim feed text; always link to the source.
