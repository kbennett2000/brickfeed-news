# ADR-0001: brickfeed-news architecture

## Status
Accepted

## Context
brickfeed-news turns a news RSS feed into a static cover page where each story
has an original headline, a short description, and a generated toy-brick image,
linking out to the source. It is a personal, non-commercial, free service.
Constraints: run generation on a subscription (not an API key) where possible;
host the static output free on Vercel; keep image generation in a separate LAN
microservice added late; never create trademark/IP exposure.

## Decision

1. **Static-site + git-as-database.** The deploy artifact is rendered HTML. A
   text-only manifest (JSON) is the source of truth for known stories and their
   metadata. Vercel (Hobby, non-commercial) serves the output and redeploys on
   push. Vercel does zero heavy lifting — no per-story build work.

2. **Orchestrator runs on our own hardware** (dev PC, then LAN server), because
   it must call the local imagegen microservice (GPU). Vercel only hosts.

3. **Canonical story ID = hash of the resolved article URL.** Google News wraps
   links in redirects; resolve before hashing. This ID drives dedup, new-story
   detection, and age-out.

4. **Idempotent, image-gated publishing.** A story with an existing generated
   image is never reprocessed. No story publishes without an image. Stories past
   a configurable age with no update are dropped and their artifacts deleted.

5. **Images never live in git.** Committing binaries bloats history permanently
   and `git rm` doesn't reclaim it. Images go to object storage / LAN-served
   storage, referenced by URL. The repo is text-only.

6. **Dual Claude generator behind one interface.** Subscription path via
   `claude -p --output-format json` (auth `CLAUDE_CODE_OAUTH_TOKEN`); API-key
   path via the Messages API (`ANTHROPIC_API_KEY`). Config selects one; default
   subscription. Claude produces headline, description, and image prompt.

7. **Brick style via prompt-wrapping.** The imagegen service is prompt-agnostic;
   brickfeed wraps Claude's image prompt with configurable, generic toy-brick
   style language. (A dedicated brick LoRA in imagegen is a possible later
   fidelity upgrade, not required.)

8. **Phasing.** Build RSS parsing + the Claude generation layer first with the
   imagegen call stubbed; roll in the real imagegen integration last.

## Consequences
- The generation loop is idempotent and resumable; a failed image just leaves a
  story pending, never a half-published entry.
- Re-rendering is cheap and never re-pays for generation.
- Legal surface stays minimal: generic brick art only, original text only, no
  publisher images, no LEGO name/marks anywhere. (See ADR-0002 if/when the feed
  source, storage backend, or scheduling is pinned down.)
