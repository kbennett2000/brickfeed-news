# ADR-0015: Opinion generation stage

## Status

Accepted

## Context

ADR-0013 designed the Opinion section (personas, cadence, idempotency keys, retention,
disclosure) and ADR-0014 added the reader-letter columnists. The persona assets, schema,
headshots, and bench all exist — but nothing writes pieces. This ADR records the
generation stage itself: how the day's author set is derived, how source articles are
selected and gated, how pieces are generated and stored, and how the stage rides inside
the publish cycle without being able to break it.

Render integration is a later cycle: pieces created now are stored as OPINION-category
manifest records with no image, and the existing publish gate (`isPublishable` requires
`imageUrl`) keeps them off the site until the hero-image/render cycle lands. That is the
launch mechanism — content presence is the switch (ADR-0013), and no config flag exists.

## Decision

1. **Author derivation is a pure function of (date, personas) — no state file.**
   `authorsFor(date, personas)` = the ADR-0013 rotation pair
   (`daysSinceUnixEpoch(UTC) % 3` over `[[alice,bob],[edgar,stryker],[larry,cynthia]]`,
   intersected with the loaded `source: news` personas) PLUS the ADR-0014 overlay (every
   `source: letters` persona whose `schedule` contains the date's UTC weekday). A missed
   day is skipped, never backfilled (`--date` exists for key derivation, not backfill —
   the candidate window always keys off the real clock).

2. **Selection is weighted by the persona's `selection_bias`, over a 24-hour pool.**
   Candidates are manifest records that are publishable (on the site), non-OPINION,
   not opinion pieces themselves, and first seen within the last 24 hours. Sections the
   persona lists weigh per their bias values (integers 1–3 today); unlisted sections get
   a small floor weight (0.25) so no story is ever unreachable, just rare. Each news
   persona samples 2–3 articles without replacement (prefer 3, accept fewer); the chosen
   story ids are persisted on the piece as `sourceArticleIds` for audit. Zero eligible
   candidates after the gate → that author is skipped for the day with a clear log line —
   never generate from nothing.

3. **The topic gate is one batched classification per run, and it fails CLOSED.**
   Before any selection, the run sends the 24h candidates' titles+summaries through the
   same `TextGenerator` seam in ONE call and demands strict JSON:
   `{"verdicts":[{"id","verdict":"eligible"|"excluded","reason"}]}` — one verdict per
   story, "if uncertain, exclude". The parser is strict: every sent id exactly once, a
   valid verdict token, nothing else. A provider failure or any parse deviation excludes
   ALL candidates for the run, logs loudly, and the news authors skip (letters authors
   are unaffected — they have no article inputs). Verdicts are computed once per run and
   shared across all of that run's authors, so the Sunday four-author run classifies
   once, not four times.

4. **Letter personas bypass gate and selection entirely.** Their prompt is
   `_shared.md` + `_letters.md` + the persona body — one completion that invents the
   letter and answers it (ADR-0014). `column_title` is persisted on the record; render
   needs it for the column banner.

5. **Output contract: first line = title, blank line, body — mapped onto the store's
   existing fields.** `headline` carries the title line, `description` carries the full
   piece body (the store keeps no separate body field; card truncation is explicitly the
   render cycle's job). Length sanity per persona spec — default 300–500 words
   (`_shared.md`), Tom 500–700 (his hard-rule override) — via a constant map pinned to
   the persona prose by tests: a body out of band by more than 2× (below min/2 or above
   max×2) fails that author; merely out of range logs a warning only.

6. **Publish = insert a manifest record keyed by the idempotency key.**
   `id` = `opinion-{author}-{YYYY-MM-DD}` (UTC, ADR-0013 decision 4). An existing key
   skips that author BEFORE any provider call — a rerun with nothing left to do makes
   zero generation calls, which is what makes launch-then-cron overlap safe. Record
   shape: `url: ""` and `sourceName: ""` (an opinion piece has no external source),
   `title` duplicates the headline (field is required), `firstSeen` = `lastSeen` = now
   (so `opinionMaxAgeHours` retention applies with no code change, ADR-0013 decision 5),
   `category: "OPINION"`, plus the new optional fields `author` (canonical persona
   name), `columnTitle` (letters only), and `sourceArticleIds` (news only). NO image
   fields — the record is deliberately unpublishable until the hero-image cycle.
   **Corollary:** records carrying `author` are exempt from the story pipeline's
   `generateAll` eligibility — without that guard the next cycle would see the image-less
   piece as "pending" and overwrite it with story-style generation.

7. **No launch flag.** Reaffirms ADR-0013: content presence is the switch. The launch
   batch is the operator running `npm run opinions -- --authors all` once; after render
   integration, the section appears because pieces exist. Zero loaded personas → the
   stage no-ops.

8. **Failure isolation: one author's failure never blocks another's.** Each author's
   select→generate→validate→publish runs independently (serially — the subscription CLIs
   behave badly in parallel) inside its own try/catch. The standalone CLI exits non-zero
   only when ALL derived authors failed (skips are not failures). Inside the cycle the
   stage is tolerant like headshots: a throw becomes a `skipped — …` stage line and the
   news cycle proceeds to render/deploy untouched.

9. **Dry-run semantics differ by entry point, by design.**
   `npm run opinions -- --dry-run` prints derived authors, gate verdicts, selections,
   and would-publish keys — it makes the single gate classification call (verdicts can't
   print without it) but zero piece generations and zero writes.
   `npm run cycle -- --dry-run` keeps the cycle's stricter contract — no provider calls
   at all — and prints a derivation-only "would write opinion piece(s) for: …" line.

## Consequences

- `ManifestRecord` gains three optional fields (`author`, `columnTitle`,
  `sourceArticleIds`); `CycleDeps` gains the `textGenerator` seam; `CycleIo` gains
  `loadPersonaAssets` (persona/asset disk reads stay on the IO boundary).
- The cycle stage order becomes ingest → generate → image → ageout → **opinions** →
  render → deploy, with opinions tolerant (never fails the run). Cron needs no change;
  the hourly cycle self-heals a morning gate failure because idempotency only skips
  authors that actually published.
- The render cycle inherits three contracts: truncate full-body descriptions on cards,
  wire byline/`column_title`/disclosure footers (ADR-0013 d.6, ADR-0014 d.6), and the
  hero-image cycle adds `imagePrompt`/`wrappedPrompt`/`imageUrl` to author-bearing
  records (the image stage then picks them up naturally via its existing
  `wrappedPrompt && !hasImage` gate).
- A permanently broken gate yields "all authors skipped" (exit 0) on pair-only days;
  the loud log line is the alarm. Chosen deliberately: a gate outage is a content gap,
  not a pipeline failure.

## Alternatives considered

- **Per-story gate calls instead of one batch.** Rejected: N calls per run for the same
  verdict quality, and the batch is small (≤ ~40 stories/day).
- **A persisted per-day verdict cache file.** Rejected: within-run sharing already
  collapses the Sunday multi-author case to one call, and idempotency-before-gate makes
  reruns free; a cache file is state to corrupt for no remaining benefit.
- **Placeholder image fields to satisfy `isGenerated` instead of the `author` guard.**
  Rejected: a non-empty `wrappedPrompt` would trigger story-style imaging THIS cycle; an
  empty one still reads as pending. The explicit exemption is smaller and honest.
- **Failing the run when the gate fails.** Rejected: the gate protects content taste,
  not data integrity; failing the news cycle over it would invert priorities.
- **A `--backfill` mode for missed days.** Rejected: ADR-0013 decision 3 is explicit —
  missed days are skipped, never backfilled; stale opinions on yesterday's news are a
  bug, not a feature.
