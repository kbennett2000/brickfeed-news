# Opinion section runbook

Operator tasks for the Opinion section: what healthy looks like, the two knobs, persona
care, and recovery. This doc is the map; the behavior lives in
[../src/opinions.ts](../src/opinions.ts) (generation, gate, staleness) and the cycle
stage in [../src/cycle.ts](../src/cycle.ts). Design: ADR-0013 through 0016 and ADR-0018.

## What normal looks like

- The hourly cycle's opinions stage runs only at/after **13:00 UTC** (≈ 7 AM Denver;
  `opinionPublishHourUTC`). The gate is `>=`, so a missed 13:00 tick self-heals at
  14:00. Before the hour the stage line reads
  `skipped — before publish hour (12 < 13 UTC)` and costs zero provider calls.
- After the hour, the stage line looks like
  `2 published, 1 skipped, 0 failed; gate passed 3/5 candidate(s)` — later cycles the
  same day are all-idempotent (`0 published, N skipped …`), which is healthy.
- **At least one piece publishes every day.** The letters schedules cover all seven
  days — tom **mon/wed/fri/sun**, priscilla **tue/thu/sat/sun** (the Sunday double is
  intentional) — and the topic gate never applies to letters, so even an all-tragedy
  news day yields a column.
- News columnists rotate in fixed pairs — alice+bob / edgar+stryker / larry+cynthia,
  picked by `daysSinceUnixEpoch % 3`. **The pairs are code by design** (`ROTATION` in
  [../src/opinions.ts](../src/opinions.ts), ADR-0013), not config.

## The knobs

| key | default | meaning |
| --- | --- | --- |
| `opinionPublishHourUTC` | `13` | UTC hour the cycle's opinions stage first runs each day. |
| `opinionMaxAgeHours` | `168` | Retention window for OPINION records (7 days; never falls back to `maxAgeHours`). |

## Manual runs

`npm run opinions -- [--date YYYY-MM-DD] [--authors all|name,name] [--dry-run]`

Direct CLI runs **bypass the publish-hour gate** — manual is deliberate. Per-author-
per-day idempotency still applies: a rerun never duplicates a day's piece and costs
zero generations for already-published authors. `--dry-run` prints gate verdicts and
selections (it spends the one gate call, nothing else) and writes nothing.

## Health: the OPINION-STALE alarm

Every cycle (including skipped-hour and all-idempotent ones) probes the store; if the
newest OPINION record is older than **36h** — or there are none — the cycle logs:

```
cycle: OPINION-STALE — newest OPINION record is 41h old (opinion-tom-2026-07-11); threshold 36h
cycle: OPINION-STALE — no OPINION records in the manifest; threshold 36h
```

Check with `grep OPINION-STALE` over the cycle log. Given the seven-day letters
coverage above, this firing is a fault, not weather. Triage in order:

1. **Provider auth** — the `claude` CLI's subscription login/token
   (`CLAUDE_CODE_OAUTH_TOKEN`). A dead provider fails pieces and the gate alike.
2. **A topic-gate fail-closed streak** — `grep "TOPIC GATE FAILED CLOSED"` in the logs.
   One is weather; every cycle for a day is the provider or the verdict JSON parser.
3. **Persona schema** — `npm test` (the persona schema tests fail loud on a bad `.md`).

A recovery publish clears the alarm the same cycle. There is no alerting beyond this
log line today (no notify seam exists in the repo).

## Adding a persona

1. Write `personas/<name>.md` — strict front-matter + the voice body. `source: news`
   needs `selection_bias`; `source: letters` needs `schedule` and `column_title`.
   Optional `bio` (ADR-0019): human-written paragraphs for the columnist page —
   inline `bio: text` for one paragraph, or a bare `bio:` line followed by indented
   lines (one paragraph each); absent → the bio page shows `byline_blurb` instead.
   Parsing is strict: any defect drops the persona and turns the schema tests red.
2. Drop the headshot at `assets/headshots/<name>.png`, then `npm run headshots`.
3. Bench-read the voice: `npm run bench:personas -- --persona <name>` (fixture mode;
   `--recent <n>` reads the newest published stories instead).
4. Commit the `.md` (the headshot never enters git; `assets/` is box-only).
5. **News personas only:** also edit `ROTATION` in
   [../src/opinions.ts](../src/opinions.ts) — the rotation pairs are code (ADR-0013).
   Letters personas schedule themselves via front-matter.

## Punching up a voice

Edit the persona `.md` body → `npm run bench:personas -- --persona <name>` → commit.
Persona bodies are human-owned; the pipeline never rewrites them. The same goes for
the optional `bio` front-matter (the columnist-page copy, ADR-0019): it is disclosure
prose, human-written only — punch it up in the same loop.

## Retiring a persona

Reverse of adding: remove the name from `ROTATION` (news) or delete its `schedule`
(letters), delete the `.md` and the headshot. No purge needed — live pieces simply stop
regenerating and age out via `opinionMaxAgeHours`.

## Re-launch / recovery

There is no purge CLI. To relaunch the section: drop the `opinion-*` records from the
manifest and delete their stored images (the ADR-0016 launch did exactly this), then

```
npm run opinions -- --authors all
```

`--authors all` runs every loaded persona, ignoring rotation and schedule — and being a
CLI run, the publish-hour gate doesn't apply.

## Disclosure copy

All one-place edits in [../src/render/templates.ts](../src/render/templates.ts), pinned
verbatim by render tests — wording changes are ADR-level decisions:

- `OPINION_BANNER` — the opinion page banner.
- `LETTERS_DISCLOSURE` — the letters-column disclosure line.
- `OPINION_META_DESCRIPTION` — the opinion page's meta description.
- `opinionMetaPrefix()` — the leading share-meta prefix on every piece.

The per-piece footer is each persona's own `byline_blurb` front-matter, not a constant.
