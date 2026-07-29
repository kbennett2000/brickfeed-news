# ADR-0025: Opinion archive retention + Opinion section cap

Status: Accepted
Date: 2026-07-29

## Context

Columnist bio pages (`/columnist/<name>.html`, ADR-0019) list a persona's opinion pieces, but
in practice show "only the last few." This is **not** a render cap — the columnist page maps
*every* live OPINION record for that author with no `.slice`/limit (`src/render/index.ts`). The
real limiter is retention: age-out (`src/ageout.ts`, "the ONLY retention decision", ADR-0013 #5)
**hard-deletes** each OPINION record from the manifest **and** deletes its hero image at
`opinionMaxAgeHours`, previously **168h / 7 days**. Since each persona writes on a ~3-day
rotation, a columnist only ever had ~2-3 live pieces — no real archive.

Simply extending retention has a side effect: the Opinion **section** page (`opinion.html`)
lists *every* live opinion piece (OPINION is exempt from the `SECTION_SLOT_LIMIT` display bound,
which is shared with the image budget). Left uncapped, a longer retention window would flood
that one page with the whole backlog.

## Decision

1. **Extend opinion retention to ~90 days.** `opinionMaxAgeHours` 168 → **2160** (config.json +
   config.example.json). No code change — `retentionHoursFor` already routes OPINION through
   this value; news retention (`maxAgeHours: 72`) is untouched. Columnist pages then accumulate
   the full ~90-day archive automatically (they read the unfiltered records).

2. **Cap the Opinion *section* page** to the most-recent `OPINION_SECTION_LIMIT` = **24** pieces
   (newest-first by `firstSeen`), via a new `recentOpinionIds` helper and an extra predicate on
   the section `base` filter in `src/render/index.ts`. This is deliberately **separate from**
   `sectionSlotIds`/`SECTION_SLOT_LIMIT` (which is shared with the image budget and must not
   change) and is **not** applied to columnist archive pages, landing pages, or the sitemap —
   all of which keep the full retained history.

Because the whole record (image included) lives for the full window, every retained piece still
has its hero image; no missing-image placeholder handling is needed.

## Consequences

- Columnist bio pages become a real archive (up to ~90 days / ~25-30 columns each), while
  `opinion.html` stays a tidy recent feed (≈ a week of columns at 24).
- **Forward-looking only.** Pieces already aged out (>7 days old) were permanently deleted and
  cannot be recovered — the archive fills out over the coming ~90 days as new columns land.
- Storage stays bounded: ~90 days of opinion images (a few hundred small blobs) instead of 7.
  The manifest grows by ~a few hundred OPINION records (git-ignored).
- `OPINION_SECTION_LIMIT` is an independently tunable code constant (like `HERO_FILL_COUNT`),
  not per-deploy config; `opinionMaxAgeHours` remains the per-deploy retention tunable.
- New tests: `recentOpinionIds` (eligibility) and a render test asserting `opinion.html` is
  capped while the author's columnist page shows all pieces. `sectionSlotIds` is unchanged, so
  its "always keeps opinions" test stays green.

## References

- ADR-0013 #5 (the single retention rule this tunes)
- ADR-0016 (opinion pipeline / image brief), ADR-0019 (columnist bio pages)
- ADR-0020 (`SECTION_SLOT_LIMIT` display==image budget — deliberately NOT reused here)
