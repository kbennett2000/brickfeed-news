# ADR-0032: Opinion supply diversity and grim-day fallbacks

## Status

Accepted — 2026-08-17.

## Context

On 2026-08-17 only **one** opinion piece published (Tom, a reader-letter column) where the section
normally runs 4–5. Investigation traced this through the whole pipeline:

- The day's four scheduled authors were `alice`, `bob`, `hodge` (news reactors) and `tom` (letters).
- The content gate (ADR-0015/0021/0022) returned **`gate passed 0/49`** — every candidate story was
  excluded. The exclusion reasons were uniformly grim: a celebrity death, a fatal drone strike,
  hurricanes/floods with fatalities, military strikes, shootings, abuse allegations. On this news
  day the gate did exactly its job.
- The three news reactors therefore had nothing to write about and skipped; Tom (letters) doesn't
  depend on news candidates, so he was the lone publisher.

The gate being strict on a grim day is only the *proximate* cause. The candidate pool itself was the
problem: in the trailing 24h it was **88% POLITICS + WORLD** (POLITICS 29, WORLD 22, BUSINESS 5,
CULTURE 1, TECHNOLOGY 1, **SPORTS 0**). Even Hodge — whose beat is SPORTS (`selection_bias SPORTS:
12`) — had an empty beat, despite a dedicated Google News SPORTS feed being configured.

Digging into *why* the pool skews so hard uncovered the real bottleneck — and it is **not** the gate,
and **not** imaging:

```
ingest (all feeds, hundreds/cycle)
   │   ← ~680-story backlog accumulates here
generate: maxStoriesPerCycle=10, pure NEWEST-FIRST   ← THE DAM
   │   (generation is what assigns category; a story never generated is never categorized)
image (categorized stories nearly all get imaged: POLITICS 77/79, WORLD 70/71)
   │
opinion candidate pool (24h, requires an image) → content gate → weighted persona pick
```

At the time of the incident the manifest held **682 un-generated stories** (no category, no
headline), **167+ of them plainly sports** (NFL/NBA/college football), plus tech (an "Anthropic worth
$2T" item), science (eclipses, a hybrid black-hole star), and lifestyle/health. Their age spread was
median 36h, max 92h — many **age out (maxAgeHours=72) before text generation ever reaches them.**

The cause is `generateAll` selecting pending records **newest-first, capped at 10/cycle**. The
high-volume POLITICS/WORLD firehose is always the freshest and most numerous, so it consumes the
entire per-cycle generation budget every cycle. Low-volume topic streams (sports, tech, science,
culture) never get generated → never get a category → never get an image → never become opinion
candidates. The 24h opinion pool is starved of exactly the "safe" material that a satirical section
most wants on a grim news day.

A key constraint falls out of this: **a pending story has no category yet** (generation assigns it),
and ingest merges all feeds into one list without recording which feed each story came from. So the
generation stage cannot diversify by target section — the section doesn't exist yet. The only
pre-generation signal for a story's likely section is *which feed it arrived on*.

## Decision

Four layers. The first two fix **supply** (get genuinely light stories into the pool); the last two
are **grim-day fallbacks** in the opinion stage. The content gate stays content-based and unchanged —
we never whitelist a category past it (a SPORTS story can be an athlete's death; a CULTURE story can
be about abuse). The target is **never-empty**: every scheduled news persona publishes each day.

### Layer B (core supply fix) — feed-origin tagging + per-feed generation quota

1. **Tag feed origin at ingest.** `feedUrls` entries gain an optional topic label; each fetched
   `FeedItem` and the `ManifestRecord` it becomes carry an optional `feedTopic` string (additive,
   nullable — records written before this ADR simply have none, treated as the general/default
   stream). This is the pre-generation section signal.

2. **Per-feed generation quota.** `generateAll` no longer drains a single newest-first queue. It
   partitions the pending backlog by `feedTopic` and reserves a minimum share of the per-cycle
   budget for each non-default topic, filling remaining budget newest-first across everything. A
   low-volume topic feed can no longer be crowded out of generation by the firehose. Ordering *within*
   a topic stays newest-first (today's sports over last week's). `maxStoriesPerCycle` is raised so the
   reserved shares don't starve the general stream (the box has the throughput; the old 10 was a
   cost-era default).

### Layer A (broaden supply) — additional safe-topic feeds

Add Google News topic feeds for inherently lighter sections (Entertainment, Technology, Science, and
a Food/Lifestyle stream) to `feedUrls`, each carrying its `feedTopic`. Deliberately sequenced **after
B**: adding feeds without per-feed generation quota only deepens the backlog. With B in place, each
new topic feed carries a guaranteed generation share.

### Layer C (grim-day fallback) — widen the opinion candidate window on gate-zero

`runOpinions` currently gates one 24h candidate pool and, if 0 pass, all news personas skip. New
behavior: when the gate returns **0 eligible** over the 24h window (and did not fail closed), re-run
candidate selection over a wider `OPINION_FALLBACK_WINDOW_HOURS` (72h) window and gate the additional
older candidates before giving up. Cheap safety net; keyed off eligibility, not on a provider error
(a fail-closed gate still fails closed — we do not paper over a broken gate by widening).

### Layer E (section ownership) — Hodge is the sole, sports-only columnist

The supply fix (B) makes SPORTS a real, populated section for the first time, which surfaces an
editorial decision: who covers it. Owner directive — **Hodge is the only columnist who covers sports,
and he covers *only* sports.** Two mechanisms, both in the weighted-selection path:

1. **`sections_exclusive` persona flag** (new optional frontmatter bool, news personas only). When
   true, the persona's candidate pool is **hard-filtered** to exactly the sections listed in its
   `selection_bias` before weighting — no `FLOOR_WEIGHT` leakage into unlisted sections. Hodge:
   `selection_bias: { SPORTS: 1 }`, `sections_exclusive: true` → sports only, always.

2. **Owned sections** (`OWNED_SECTIONS = { SPORTS }`). For any persona that does **not** explicitly
   list an owned section, that section's weight is **0** (never), not `FLOOR_WEIGHT`. SPORTS is
   removed from every other persona's `selection_bias`, so no one but Hodge ever draws a sports
   story. Non-owned sections keep the existing "unlisted → rare-but-reachable" `FLOOR_WEIGHT`
   behavior, so this is a surgical change, not a global one.

Consequence for the never-empty guarantee: on a day with no eligible sports candidate (empty beat or
all-gated), Hodge falls through to the Layer-D evergreen path and writes a sports-voiced evergreen
column rather than a news-anchored one.

### Layer D (never-empty) — evergreen last resort for news personas

If, after C, a news persona still has **no eligible pick**, it does not skip. It generates an
**evergreen voice column** — an untethered piece in the persona's voice with no source story
(`personas/_evergreen.md`, a hand-maintained asset like `_letters.md`). This guarantees every
scheduled news persona publishes. Evergreen pieces reuse the whole existing publish path (title/body
validation, image brief, imaging, comments); they simply pass no `SOURCE ARTICLES` block and an
evergreen instruction instead. A distinct outcome status records that the piece was an evergreen
fallback so the stage summary and logs stay honest about which pieces were news-anchored.

## Consequences

- **The pool diversifies at the root.** Sports/tech/science/culture stories get a guaranteed
  generation share, so they reach the opinion pool instead of aging out un-generated. Hodge's beat
  (and the front-page sections) fill in as a side benefit — this fixes an under-served-sections bug
  the opinion incident merely surfaced.
- **Grim days stay full.** C widens the net; D guarantees a floor. A genuinely dark news cycle yields
  a section of mostly evergreen/lighter pieces rather than a near-empty one.
- **The gate is untouched and still authoritative.** No category bypasses it; nothing grim gets
  satirized because a feed labeled it "sports."
- **Schema is additive and backward-compatible.** `feedTopic` is optional everywhere; existing
  manifests and configs load unchanged (a bare-string `feedUrls` entry keeps working = the default
  stream). `maxStoriesPerCycle` raising is config, not schema.
- **Cost rises with generation volume.** More stories are generated per day (text via Haiku, cheap;
  images via keyless grok-terminal). Acceptable for the hobby budget; `maxStoriesPerCycle` remains the
  single throttle. Evergreen pieces add at most one generation per news persona per grim day.
- **Delivered in slices** (this ADR is the contract): B-schema (feed tag) → B-quota (generation) →
  A (feeds) → C (window) → D (evergreen), each with tests, smallest reviewable unit first.
```
