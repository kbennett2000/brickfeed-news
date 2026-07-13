# ADR-0017: Ad rotator rebuild + opinion byline sizing

## Status

Accepted

## Context

Three user-visible defects reached the live site together. Opinion byline avatars
(ADR-0016) rendered at their natural 256px asset size, stacked above the byline text;
the banner-ad leaderboard played in the same order on every page load; and after eight
new columnist ads landed, one displayed for a normal interval while the other seven
flashed past almost instantly.

On-box diagnosis against the real `assets/ads/` and the live origin found a single
shared root cause behind the first and third symptoms, and a design flaw behind the
second:

- **The stylesheet is a day-stale shared asset.** `/styles.css` ships with
  `Cache-Control: max-age=86400, stale-while-revalidate=604800` and the `<link>` carries
  no cache-buster, while HTML revalidates every visit. Any browser that visited before a
  deploy holds the old CSS against fresh markup for up to a day.
- **The avatar had no size of its own.** Its 28px sizing lived only in the (stale)
  stylesheet; with old CSS, the global `img { max-width: 100%; display: block }` rule
  rendered the raw 256px asset full-width and block-stacked.
- **The "rotator" was build-time CSS keyed to the ad count.** `adAnimationCss(n)`
  generated one shared `@keyframes` cycle of `n × 7s` with per-slide negative
  `animation-delay` staggers. Order was therefore identical every load by construction —
  and the slide count was baked into the cached stylesheet. A browser holding the 18-ad
  CSS against the fresh 26-slide HTML gave slides 19–26 no delay rule at all, syncing
  all eight columnist ads to slot 1: the topmost showed a full slot, the rest flashed or
  never surfaced.
- The audit came back clean otherwise: all 26 sidecars parse, all 26 slide images return
  200 at the live origin. Nothing failed to upload; no sidecar field differs between the
  ad that "worked" and the seven that didn't (the contract had no per-ad fields beyond
  the URL to differ on).

## Decision

1. **The banner rotator moves from generated CSS keyframes to a small inline JS
   rotator.** Each slide carries its hold time as a `data-duration` attribute; the
   script reads the actual DOM slide list, so slide count can never desync from timing
   no matter how stale the stylesheet is. The stylesheet keeps only static rules: a
   0.9s opacity transition for the crossfade, an `.is-active` visible state, and a
   `:not(.is-live)` first-slide fallback so no-JS visitors (and reduced-motion
   visitors, for whom the script bails) still see a static first ad. `pointer-events`
   toggles with visibility exactly as before, so only the visible ad is clickable.

2. **The play order is shuffled client-side once per page load** — Fisher–Yates over
   the slide indices, then cycled in that fixed order. No reshuffle on advance, so a
   pass never shows adjacent repeats. Shuffle and queue-building are pure functions
   (`shuffleIndices`, `buildAdQueue`) unit-tested directly and embedded into the shipped
   script via `Function.prototype.toString()` — one definition, no test/ship drift.

3. **The sidecar contract gains an optional strict `duration:` line, parsed
   personas-style.** `duration: <seconds>` with a finite value in **2–60** sets that
   ad's hold time; absent, the default is **7s**. A present-but-invalid value (NaN,
   zero, negative, out of bounds) DISQUALIFIES the ad with a named warning — it is
   never laundered into a default, and a malformed ad can never enter the queue with a
   zero-duration slot. Other extra lines remain ignored (back-compat with the
   "anything after the first line is ignored" contract).

4. **A pair missing its image half now warns loudly instead of skipping silently.**
   Asset creation is the operator's side of the fence; a half-delivered ad should be
   named at ads-build time, not discovered by its absence. (An image without a sidecar
   stays a silent skip: it is the documented "parked creative, not yet live" state.)

5. **`styles.css` is cache-busted with a content-hash query** (`?v=<fnv1a(STYLES)>`).
   This becomes possible because decision 1 makes the stylesheet fully static — nothing
   per-render is appended anymore. A content hash (not a timestamp) means hourly
   renders don't bust an unchanged sheet; any real CSS change propagates on the next
   HTML revalidation instead of a day later. This kills the whole stale-CSS failure
   class, for the rotator and the byline alike.

6. **The byline avatar is sized by presentational attributes** — `width="48"
   height="48"` on the `<img>` — so sizing survives stale or absent CSS entirely (and
   reserves layout, avoiding CLS). The CSS renders it as a hard-edged 48px square with
   the photo-frame border, per the house thumbnail convention (`.sharesheet__thumb`;
   the sheet's stated "no border-radius" aesthetic) — the previous 50% circle was an
   outlier. The row stays one inline flex line — avatar, display name, column title,
   timestamp — with a gap after the avatar and vertical whitespace around the row on
   piece pages.

## Consequences

- Rotation now requires JS; no-JS visitors see the first ad statically, which is the
  same fallback the CSS scheme already provided for reduced-motion visitors.
- Ad hold time is now per-ad and operator-controllable from the sidecar, bounded 2–60s.
- `AdView` gains `durationMs`; the render emits it as `data-duration` and never
  computes timing CSS again (`adAnimationCss` is deleted).
- The first page load after this deploy still fetches with the old un-versioned URL
  semantics, but the new HTML links `styles.css?v=…`, which no browser has cached — so
  this change itself propagates immediately.
- A malformed sidecar now costs the ad its slot (with a named warning) rather than
  degrading the whole rotation; the hermetic parser tests are the merge gate for that
  behavior, since `assets/` is git-ignored and invisible to CI.

## Alternatives considered

- **Fixing the CSS scheme in place** (regenerate keyframes, keep fixed order). Rejected:
  the count-in-cached-CSS coupling is the root cause and survives any keyframe fix, and
  per-load shuffle is impossible in build-time CSS.
- **Shuffling server-side at render time.** Rejected: the site renders hourly and pages
  are CDN-cached — every visitor in the same hour would see the same "shuffle", which
  is the bug restated.
- **A hashed stylesheet filename** (`styles.<hash>.css`) instead of a query param.
  Rejected for now: it complicates the deploy artifact (stale files accumulate or need
  cleanup) for no propagation benefit over `?v=` with revalidating HTML.
- **Keeping the circular avatar.** Rejected: the sheet's aesthetic is explicitly
  hard-edged ("no border-radius"), and every other thumbnail (sharesheet, figure
  frames) is square with the photo border; the circle was an unreviewed outlier.
- **Duration as a global config key.** Rejected: per-ad control was the ask
  ("carrying its configured duration"), and a config key can't vary per creative;
  the sidecar is the ad's own file and already the operator seam.
