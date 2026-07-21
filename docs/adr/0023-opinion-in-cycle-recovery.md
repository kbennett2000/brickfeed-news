# ADR-0023: Opinion in-cycle recovery — generation retry + opinion-first imaging

## Status

Accepted

## Context

Opinion pieces are meant to publish at the "Sunrise" hour (04:00 America/Denver = 10:00 UTC,
ADR-0018). The schedule itself works: the box runs MDT and the `0 */4 * * *` cron's 04:00 local
tick lands exactly at the `opinionPublishHourUTC: 10` gate. Yet the section has been missing that
target through two failure modes, and both currently recover only on the *next* 4-hour cron tick
(the publish-hour gate's `>=` self-heal, ADR-0018) — or, in the image case, not at all for cycles:

- **Late pieces (observed: Tom 7/19 → 08:01, Cynthia 7/20 → 08:02).** One author's piece failed
  validation at the 04:00 run — `output missing title line or body`, or `body is N words — out of
  band`. Haiku intermittently emits a malformed or wildly out-of-band piece; there was **no
  in-cycle retry**, so a transient bad roll deferred that author a full 4 hours to the 08:00 tick.

- **Missing pieces (observed: Bob 7/21).** Bob's text published on time at 04:03, but his Grok hero
  image failed (`pending (52.9s)` → stage `1 failed`). Per the hard guardrail *a story is never
  published without an image*, the piece is invisible (`isPublishable` false). Opinions are exempt
  from the section slot cap (ADR-0020) but still competed **newest-first** for the
  `maxStoriesPerCycle: 10` image budget: at the 08:00 run, ten freshly-ingested news stories (all
  newer than Bob's 04:00 opinion) took every slot and Bob was deferred again. An opinion whose
  image fails once can stay dark for cycles — the starvation class already flagged in `HANDOFF.md`.

The owner has previously declined raising `maxStoriesPerCycle`, so the fix must work **within** the
existing image budget — by ordering and a bounded retry, not by enlarging the cap.

## Decision

1. **Bounded in-cycle retry for opinion generation.** In `runOpinions`, the per-author
   generate → `splitTitleBody` → length-check → image-brief sequence is wrapped in an attempt loop
   bounded by `MAX_PIECE_ATTEMPTS = 2` (one retry). Each of the four transient failures re-rolls the
   piece in the **same cycle** instead of deferring; only when all attempts are exhausted is the
   author marked `failed` (unchanged downstream shape and detail text). Selection and the topic gate
   stay outside the loop — they're deterministic for the run; only piece generation is
   nondeterministic. The publish-hour `>=` self-heal (ADR-0018) remains the outer net for a whole
   failed cycle. Cost is bounded: one extra Haiku call (~9s) beats a 4-hour delay.

2. **Opinion-first image ordering.** The image stage's eligibility sort now orders OPINION records
   ahead of all others, newest-first within each group. Opinions are ≤~4/day against a budget of
   10, so this guarantees their slot while news still keeps ≥6 and the "fresh news gets the lead"
   intent holds within the news group. This extends ADR-0020's slot-cap exemption to the per-cycle
   image budget it didn't previously cover. **`maxStoriesPerCycle` is unchanged** (owner directive).

3. **Single inline retry for a failed OPINION image.** Prioritization alone still leaves a piece
   whose image *failed* (not merely deferred) dark until the next cron. So a failed OPINION image is
   re-attempted once inline before being recorded pending. Bounded to opinions (≤~4) so it can't
   inflate Grok latency for the news pool. It rescues a transient timeout (Bob's case); it does not
   help when Grok is out of credit entirely (`HANDOFF.md`) — nothing in-process can.

## Consequences

- Transient Haiku malformation and transient Grok image misses on opinions now recover **within the
  04:00 cycle** instead of 4 hours late (or, for images, not for many cycles).
- Slightly higher worst-case cost per cycle: up to one extra piece generation per failing author and
  one extra image call per failing opinion — both bounded, both cheap relative to the delay avoided.
- The news pool is unaffected in the common case (opinions ≤4 ≪ budget 10); a pathological opinion
  backlog exceeding the budget could in theory crowd news, but opinions age out and are few.
- No config surface changes; `MAX_PIECE_ATTEMPTS` is a module constant, `maxStoriesPerCycle` and the
  publish-hour gate are untouched.

## References

- ADR-0013 (opinion architecture, rotation), ADR-0016 (image brief), ADR-0018 (publish-hour gate /
  self-heal — the outer safety net this ADR complements), ADR-0020 (slot-based hero eligibility —
  opinion slot-cap exemption this ADR extends to the image budget), ADR-0022 (TTS failover).
