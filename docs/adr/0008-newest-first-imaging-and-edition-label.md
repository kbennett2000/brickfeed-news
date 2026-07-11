# ADR-0008: Newest-first imaging + time-of-day edition label

## Status
Accepted

## Context

Two problems surfaced once the site was live.

**1. The lead lagged ~14h behind the news.** `generateImages` selected which stories to image
in **manifest insertion order (oldest-first)**, capped at `maxStoriesPerCycle` (20). Because
ingest brought ~24 new stories/cycle — more than the cap — the image backlog grew and the
"imaging frontier" crawled through old stories. The freshest stories had generated text but no
image, so they failed the image-gate (ADR-0001 #4, ADR-0004: no publish without a resolving
image) and could never reach the lead. The publish order is newest-first by `firstSeen`
(ADR-0004 / `publish.ts`), so the lead is "the newest story that has an image" — but that
newest-imaged story was always an old one, and it only advanced in slow lurches.

**2. The masthead edition was a static string.** The utility strip read a fixed
`Late Brick Edition`, unrelated to when the cron actually ran.

## Decision

1. **Image newest-first.** `generateImages` now orders eligible records (has `wrappedPrompt`,
   no image) by `firstSeen` **descending** before applying `opts.limit` — the same key the
   render/publish layer sorts by. The freshest stories get a picture (and thus the lead) first.
   Older un-imaged stragglers left beyond the cap are **intentionally** left to age out
   unpublished (72h from `lastSeen`) rather than slowly draining a growing backlog — a story
   that never got an image within a day of being seen is stale news anyway. Everything else in
   the stage (reclear-stale-refs, all-or-nothing store, deterministic apply) is unchanged.

2. **Modest cap bump: `maxStoriesPerCycle` 20 → 40** (the default; the box inherits it). Sized
   to cover a cycle's fresh intake (~24) with headroom so newest-first keeps the lead current.
   ~40 images ≈ a few minutes wall time at concurrency 4 — negligible for the 4-hourly cron.

3. **Time-of-day edition label.** The edition is derived from the render clock, bucketed into
   six 4-hour windows: `00 Midnight, 04 Sunrise, 08 Morning, 12 Afternoon, 16 Evening,
   20 Night` (`floor(hour/4)`, so an off-schedule run still lands in the right window). Pure
   helpers `editionForHour` / `editionLabel` live in `render/format.ts`.

4. **Timezone-aware, still hermetic.** The hour is computed in a configurable IANA zone
   (`render.timeZone`, new; default `"UTC"`) via `Intl`, mirroring `formatMastheadDate` — which
   also gains the same `timeZone` param so the dateline and edition never disagree. The default
   keeps the render deterministic (CI runs anywhere); the box sets `render.timeZone` to its
   local zone so the six labels line up with the local cron wall-clock.

## Consequences

- The front page tracks fresh news: the lead is the newest story imaged this cycle, not the
  head of an old backlog. The old text-only backlog drains via age-out instead of imaging.
- If ingest ever sustainably exceeds 40 new/cycle, the oldest of a single cycle's intake could
  still be deferred — tune `maxStoriesPerCycle` up (it's config).
- `render.timeZone` must be set on the box for local-time editions; unset, editions follow UTC.
  The dateline now honors the same zone, so date + edition stay consistent.
- Supersedes nothing structural; refines ADR-0004's publish-ordering consequence (imaging order
  now matches publish order) and is chrome-only for the edition.
