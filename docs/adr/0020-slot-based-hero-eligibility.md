# ADR-0020: Slot-based hero eligibility

## Status

Accepted

## Context

Grok spend is now entirely the image stage — text generation runs on Haiku (ADR-0011),
one cheap one-shot per story. The image stage (`generateImages`, `src/image.ts`) images
**every** ingested non-opinion story that has a `wrappedPrompt` and no image yet, newest-first,
capped only by `maxStoriesPerCycle`. It pays for a hero regardless of whether a reader could
ever encounter that story. Two classes of story burn Grok for nothing:

1. **Below-the-fold stories.** The render is unbounded. The homepage cover (`renderCover`) shows
   a lead + a `secondaryStoryCount` rail + `HERO_FILL_COUNT` fill cards + an **unbounded**
   "Across the Brickyard" overflow of every remaining non-opinion story; each section page
   (`renderSection`) lists **every** live story in its category. So there is no real "slot" today
   — but there is also no reason to hero the 50th-freshest Business story.
2. **Near-age-out stories.** A story ingested with a stale `lastSeen` gets a hero and then ages
   out (72h from `lastSeen`, `retentionHoursFor`) hours later — often before anyone sees it.

The visibility model, as found (recorded here so the eligibility rule is anchored to it): a story
renders **only** if it has a resolvable image (`verifiedPublishableRecords`, image-gated publish),
and then appears on the cover, its section page, its own `s/<id>.html` landing page, and the
sitemap. Stories are ordered newest-first by `firstSeen` (ADR-0008, `publishableRecords`). Sections
are the fixed 8-member `CATEGORIES`; a story's section is its `category` (undefined → WORLD).
Opinion pieces are marked by `author` being present, are excluded from the cover, and appear only
on `opinion.html` — 2–4/day, by design (ADR-0015/0016).

This slice narrows the image stage to reader-encounterable heroes and makes the section listings
bounded, sharing one constant so the two can never drift. It is image-stage + display-bound only:
provider, cadence, opinions/gate, personas, retention semantics, the generate stage, and deploy are
untouched.

## Decision

1. **One shared constant, `SECTION_SLOT_LIMIT = 30` (`src/eligibility.ts`).** It is simultaneously
   the top-K slot test for imaging and the per-section display bound for the render. A single code
   constant (like `HERO_FILL_COUNT`), not config: it encodes the image-budget-equals-display
   invariant, not a per-deploy tunable. Generous by design — with 72h retention a section rarely
   holds 30 live stories, so the new bound is **tail-only**; nothing above the fold changes.

2. **A non-OPINION story earns a hero iff BOTH tests pass.**
   - **Slot test:** it ranks within the top-`SECTION_SLOT_LIMIT` of its section by newest-first
     `firstSeen`, competing against **all live stories in that section, imaged or not** —
     already-imaged records occupy slots because they are ranked too. Ranking buckets by
     `normalizeCategory(category)` (undefined → WORLD), exactly the sections the render displays.
   - **Lifetime test:** its remaining life `= retentionHoursFor(category, config) − (now − lastSeen)`
     is at least **`HERO_MIN_LIFETIME_HOURS = 12`**. This is a *read* of the existing retention
     decision (`retentionHoursFor`, ADR-0013 #5) on the same `lastSeen` basis age-out uses — never
     a change. An unparseable `lastSeen` is treated as infinite life, matching age-out keeping NaN
     records. Twelve hours is the "won't vanish overnight" floor: a story that would age out before
     the next morning's readers is not worth a paid image.

3. **OPINION records are exempt — always imaged.** Marked by `author` (or an OPINION category),
   they are 2–4/day, always displayed, and part of the design; the slot/lifetime gate never applies
   to them, and they are never capped in the render.

4. **The decision is one pure function, recomputed fresh each cycle.** `heroEligibility(records,
   config, nowMs)` classifies every live record into `eligible` / `skipped` (already imaged or not
   generated) / `belowFold` / `nearAgeout` — no persisted skip state. Newest-first ordering makes
   the slot decision naturally stable across cycles, so a story doesn't flap in and out. Precedence
   when a record fails both tests: **below-fold first**, so `nearAgeout` counts only stories that
   were *in* a slot but too close to death — the meaningful "we'd have paid, but it's dying" bucket.

5. **The render lists only in-slot stories, via the same constant.** `renderSite` computes
   `sectionSlotIds(records, SECTION_SLOT_LIMIT)` once and filters **both** the cover overflow and
   the section grids by it, so a straggler can't show on one surface but not the other. Landing
   pages, the sitemap, and columnist archives keep the **full** record set (direct access, not a
   browsable slot — no extra Grok cost, no regression). Local articles (ADR-0010, own images) merge
   in after the filter and are unaffected. Because display shows only imaged records and images are
   only minted for top-K, the freshest imaged stories always sit within the listed top-K; only a
   section that exceeds 30 live imaged stories gets its tail trimmed.

6. **The cycle summary gains the new counts; the deploy guard is unaffected.** The image stage's
   line becomes `N generated, N skipped-below-fold, N skipped-near-ageout, N failed`, and the
   dry-run mirror derives its counts from the same `heroEligibility` so the two can't drift. The
   filter lives inside `renderSite`; `verifiedPublishableRecords` / the `records.length` the
   refused-empty deploy guard keys off are unchanged.

## Consequences

- The image stage pays Grok only for heroes within a section's top-30 that have >12h of life —
  per-cycle burn drops in proportion to the reported below-fold + near-age-out counts. A backlog
  makes below-fold nonzero immediately.
- Section pages are now bounded at 30 cards; the homepage overflow is bounded per section by the
  same number. With the generous limit this is tail-only — above the fold is byte-identical.
- A previously-imaged story that slips below rank 30 (newer stories arrived) keeps its image until
  age-out but drops out of the listings; it is never re-imaged (idempotent) and never re-listed.
- `ImageResult` gains `belowFold` and `nearAgeout`; `heroEligibility` / `sectionRanks` /
  `sectionSlotIds` are the reusable, hermetically tested seam both the image stage and the render
  consume.
- The slot ranking and the render's per-section split now share `sectionRanks`, so "which stories
  are in a section, in what order" has a single definition.

## Alternatives considered

- **Bound only the section pages, leave the homepage overflow unbounded.** Rejected: a straggler
  with a lingering image would then show on the cover but not its section page, and the "display
  bound == image budget" invariant would hold on one surface only. Filtering both with one
  `sectionSlotIds` set costs nothing extra and keeps the surfaces consistent.
- **Persist a per-story "skipped below fold" flag.** Rejected: newest-first ranking is already
  stable, so recomputing fresh each cycle is simpler and self-heals — a story that rises back into
  the top-K (e.g. after an age-out thins the section) is imaged next cycle with no bookkeeping.
- **Make `SECTION_SLOT_LIMIT` / `HERO_MIN_LIFETIME_HOURS` config.** Rejected: they encode the
  image==display invariant, not an operational knob; splitting them across config risks the budget
  and the bound drifting, which is the exact failure this ADR exists to prevent.
- **Measure remaining life from `firstSeen` instead of `lastSeen`.** Rejected: age-out fires off
  `lastSeen`, so the lifetime test must use the same basis or it would skip stories that are
  actually safe (still in the feed, `lastSeen` fresh) or hero stories that will die anyway.
- **A global top-N image cap instead of per-section slots.** Rejected: a single busy section could
  consume the whole budget and starve every other section's lead; per-section top-K guarantees each
  visible section still gets its freshest heroes.
- **Drop below-fold stories from the manifest entirely.** Rejected: they are still valid stories
  that may rise into a slot as a section thins; only their *imaging* is deferred, and they age out
  normally if they never surface.
