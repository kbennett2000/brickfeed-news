# ADR-0006: Publish-cycle orchestrator + CLI-direct Vercel deploy

## Status
Accepted

## Context
Slices 1–7 built each pipeline stage as an independent, pure, never-throw module
(`ingest` → `generateAll` → `generateImages` → `ageOut` → `renderSite`) with a thin CLI
apiece. Nothing sequenced them into one run, and ADR-0005 explicitly left `site/` as a
gitignored artifact "for the deploy slice to pick up." This is the final slice: run the
whole pipeline in one process on the LAN box and publish the rendered site.

ADR-0001 (#1) assumed Vercel "redeploys on push". In practice the orchestrator already runs
on our own hardware (ADR-0001 #2) to reach the GPU imagegen service, and the repo is
deliberately text-only with `site/` gitignored — so there is no committed artifact for a
git push to trigger a deploy from. Deploying directly with the Vercel CLI from the box is
simpler and matches where the work already happens.

## Decision

1. **One in-process orchestrator (`src/cycle.ts`), stages called directly in contract
   order:** ingest → generate → image+store → ageout → render → deploy. It calls the
   existing module functions (not the npm scripts), threading the manifest in memory and
   persisting after each mutating stage (crash-resilience across a minutes-long image run).
   Render consumes `publishableRecords(manifest)` directly — no read-back of `published.json`.

2. **Two failure tiers.** A STORY-level failure is already swallowed inside each module
   (a bad story stays pending, the run continues). A STAGE hard-failure (a thrown error —
   e.g. a disk write failing) is logged, aborts the run BEFORE deploy, and yields a non-zero
   exit so cron/monitoring catches it.

3. **CLI-direct deploy (`src/deploy.ts`), never-throw.** Shells out to a configured command
   (default `vercel --prod --yes`) with cwd = the render output dir, and returns a status
   rather than throwing. This supersedes ADR-0001 #1's "redeploy on push": the box deploys
   the `site/` artifact itself; git is not the deploy trigger.

4. **Empty/invalid-render GUARD.** Deploy is refused (a benign `refused-empty`, not a
   failure — exit 0) when the render produced no `index.html` or zero publishable records,
   so a bad pipeline run can never overwrite a good live site. A legitimately-empty early
   cycle simply does not publish. Deploy runs only when render succeeded with content.

5. **Injected boundaries → hermetic tests.** `runCycle(config, deps, opts)` takes the clock,
   fetch, the three CONFIGURED providers, the deploy subprocess (`DeployRunner`), and a
   `CycleIo` filesystem boundary. `cycle-cli.ts` wires the real ones; tests pass fakes. This
   is what makes "stages run in exact order", "hard-failure aborts before deploy", the guard,
   and "`--dry-run` writes nothing" all assertable without disk, network, or a real deploy.

6. **`--dry-run` logs intended actions only.** It reads the manifest read-only and logs what
   each stage WOULD do (feeds, pending, eligible images, stale, publishable, intended deploy
   command+cwd); it calls no providers, no network, writes nothing, deploys nothing.
   `--no-deploy` runs every stage but skips deploy; `deploy.enabled: false` has the same
   effect from config.

7. **Keyless `grok-terminal` providers.** Prod runs on a subscription with no API key for
   BOTH text and image. A new `grok-terminal` provider (selected by config, never hardcoded)
   shells out to a configured subscription CLI — the same never-throw, stdin-prompt,
   subprocess-injected pattern as the `claude -p` SubscriptionGenerator. Text expects the
   model's JSON reply on stdout (parsed by the shared defensive parser); image expects raw
   PNG bytes on stdout. The exact CLI binary/flags are configurable (`command` + `args`) and
   tuned on the box.

8. **Config `deploy` block; secrets stay in `secrets.ts`.** `deploy.command` /
   `deploy.cwd` (defaults to render outputDir) / `deploy.enabled`. Any Vercel token for
   CI-like contexts is read only via the new `getVercelToken()` getter and appended as
   `--token` by the deploy runner; the box normally authenticates once via `vercel login`.

9. **Cron safety (`scripts/cycle.sh`).** Wraps `npm run cycle` in a non-blocking
   `flock -n /tmp/brickfeed.lock` so an overlapping tick SKIPS rather than racing a
   still-running cycle; logs to a file and passes through the exit code. The crontab schedule
   is a configurable placeholder; `vercel login`/`vercel link` and the grok CLI subscription
   login are one-time HUMAN prerequisites, documented in the script header and HANDOFF.

## Consequences
- The full pipeline is one idempotent, resumable command; re-runs re-pay for nothing already
  done, and a mid-run crash leaves earlier stages persisted.
- The live site is protected: an empty or failed render never deploys over good content, and
  a hard failure exits non-zero without deploying.
- Deploy diverges from ADR-0001 #1 (CLI-direct, not git-push). The repo stays text-only;
  `site/` remains a gitignored build artifact produced and deployed locally.
- Legal surface unchanged: generic brick art only, original text only, no publisher images,
  no trademark terms — the `grep -rin lego` and `process.env`-in-secrets-only gates still
  hold (the deploy token routes through `secrets.ts`).
- Trade-off: the `grok-terminal` image contract (raw PNG on stdout) is an assumption tuned on
  the box during live-verify; a CLI that emits base64 or a file path would need a config/flag
  adjustment, not a code change to the never-throw plumbing.
