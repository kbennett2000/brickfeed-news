# Handoff

## Image prompts name no real people — Grok refuses named likenesses (ADR-0024)

**Root cause of Bob 7/21 staying dark, found by direct reproduction — NOT a code bug, NOT
storage/credit, NOT transient.** Grok's `/imagine` skill now **refuses to draw a named real person
from scratch**: it demands a reference photo to use `image_edit`. Our headless provider sandbox
denies `Bash`/`Shell`/`Terminal` (`grokHeadlessArgs`), so Grok can't download the reference, gives
up asking the operator to upload one, and **exits 0 with no image**. The provider sees no file →
`null` → the story fails to image every cycle. The ADR-0023 opinion retry can't help — retrying a
refusal yields another refusal. Reproduced: Bob's "Former mayor Andy Burnham…" fails; a generic
prompt succeeds. A latent second case was found (POLITICS story naming "JD Vance and Usha").

**Durable fix (branch `fix/image-prompts-no-real-names`, code-only):**
- `src/prompt.ts`: removed the "a caricature of a well-known public figure is fine" allowance;
  added a hard rule — never name/depict an identifiable real individual in `imagePrompt`; use a
  generic role ("a former mayor", "a government official"). `caption` (display text, not sent to
  Grok) may still name people.
- `src/opinions.ts` `buildImageBriefPrompt`: same hard rule added; doc comment cites ADR-0024.
- New `docs/adr/0024-image-prompts-no-real-names.md`; regression anchors in `test/prompt.test.ts`
  + `test/opinions.test.ts`. `npx tsc --noEmit` clean; full vitest **774 passed / 1 skipped**.
- Enforcement is prompt-side (best-effort); a future deterministic name-guard is possible if the
  model keeps leaking names.

**Operational unstick (done this cycle, out-of-band — manifest is git-ignored so not committed):**
Anonymized Bob's and the JD-Vance story's `wrappedPrompt` in `data/manifest.json`, re-ran
`npm run images` (**6 stored, 0 failed**, incl. Bob), `npm run render`, and `vercel --prod` →
Bob is **LIVE** (deploy `dpl_FqSkLjqiWiTVf1a7Kpb6VQqjuvU6`, READY). Both required `source cron.env`
first (Blob token). The `images` CLI wires **no logger**, so it prints nothing until its final
summary line — silence ≠ hung.

## Opinion in-cycle recovery: generation retry + opinion-first imaging (ADR-0023)

Fixes two ways opinions missed the 04:00 Sunrise target, both of which previously recovered only on
the *next* 4-hour cron tick (or, for images, not for many cycles). Diagnosed from `cycle.log`:

- **Late text (Tom 7/19 → 08:01, Cynthia 7/20 → 08:02):** a transient malformed / out-of-band Haiku
  piece failed validation at 04:00 with **no in-cycle retry**, so the `>=` publish-hour self-heal
  (ADR-0018) deferred the author a full 4 hours.
- **Missing piece (Bob 7/21):** his text published on time (04:03) but his Grok hero **image failed**;
  per the no-image-no-publish guardrail he was invisible, and the newest-first `maxStoriesPerCycle:10`
  image budget kept deferring his 04:00 opinion behind fresher news every cycle (the starvation class
  already flagged lower in this file).

**Changes (code-only; no config, no `maxStoriesPerCycle` bump — owner directive honored):**
- `src/opinions.ts`: `MAX_PIECE_ATTEMPTS = 2` — the per-author generate→validate→brief sequence
  retries once in the same cycle before failing. Selection/gate stay outside the loop.
- `src/image.ts`: eligibility sort now **OPINION-first**, newest-first within each group, so opinions
  (≤~4/day vs. budget 10) never lose a slot to fresh news (news still keeps ≥6). Plus a **single
  inline retry for a failed OPINION image** so a transient Grok miss recovers same-cycle. Won't help
  if Grok is out of credit entirely.
- New `docs/adr/0023-opinion-in-cycle-recovery.md`; new tests in `test/opinions.test.ts` +
  `test/image.test.ts`. `npx tsc --noEmit` clean; full vitest **777 passed / 1 skipped**.

**Not done here (operational, needs the box):** these fixes take effect once the box's checkout
updates. To clear **today's** stuck Bob immediately: on the box, `source cron.env` then
`npm run images` (opinion-first ordering images him first) → it will re-image and the next
render/deploy publishes him. The live dry-run (`npm run opinions … --dry-run`) was intentionally
skipped — it makes a live gate call, and author derivation/selection is pure and untouched (covered
by unit tests).

## Parser hardening: preamble/refusal/junk guard on generated articles (closes the fragility flag)

The "latent fragility to watch" flagged below (opinion parser trusts line 1 as the title) is now
**fixed in code** — no more relying on manual regeneration when Haiku leaks chatter.

- **New pure module `src/sanitize.ts`** — dependency-free string guards: `stripWrappingFence`
  (unwrap a whole-completion ```` ``` ```` fence), `looksLikeRefusal` (anchored, requires a
  first-person modal + a refusal object, so titles like "I Can't Even" don't trip it),
  `recoverLeadingTitleRegion` (skip leaked preamble / bare `---` delimiters / `Title:` labels to
  find the REAL title), `stripTitleDressing`, and `MAX_TITLE_CHARS/WORDS` (120/20) bounds.
- **`splitTitleBody` ([src/opinions.ts](src/opinions.ts))** now: unfence → refusal→null →
  recover-title → existing dressing strip → **length bound** (a paragraph-as-title → null). The
  exact Priscilla leak ("I see the task:… \n---\n **Wisdom's Moat** \n body") now recovers
  "Wisdom's Moat". Fail-closed path unchanged (null → author fails "output missing title line or
  body").
- **`parseGeneratorOutput` ([src/generator/parse.ts](src/generator/parse.ts))** (news JSON, already
  robust) gets a light touch: reject refusals up front, reject a headline > 300 chars (leaked prose).
- **Design invariant:** every guard either recovers the correct content or fails closed — recovery
  only strips when a valid short-title + non-empty body remains, so it can **never substitute a wrong
  title**. Legit short titles that open with a stop word ("Okay Boomer") are preserved.
- **Tests:** new `test/sanitize.test.ts`; extended `test/opinions.test.ts` (the reported leak,
  delimiter/label/opener recovery, refusal & paragraph-as-title → null, conservatism cases, plus
  two publish-path integration tests) and `test/generator.subscription.test.ts` (refusal / stray-JSON
  / overlong-headline → null; the "Sure! Here is the JSON…" happy path still parses). `npx tsc
  --noEmit` clean; full vitest **769 passed / 1 skipped**. Code-only change — no config/deploy.

## Opinions → Sunrise edition daily; manual catch-up for today; Priscilla preamble bug fixed

Owner directive (2026-07-14 eve): opinion pieces should publish in the **Sunrise edition daily**,
generated by the **04:00 run**; catch up today's missing pieces immediately.

- **Schedule (box config, gitignored — recorded here since git can't):** `config.json`
  `opinionPublishHourUTC` **13 → 10**. Cron is `0 */4 * * *` in system-local **MDT** (00/04/08/12/16/20
  MDT = 06/10/14/18/22/02 UTC); `render.timeZone` is America/Denver. The gate opens at `getUTCHours()
  >= 10`, so the first qualifying run is **10:00 UTC = 04:00 MDT = Sunrise edition** (the old 13 opened
  at 14:00 UTC = 08:00 MDT = Morning). No code/ADR change — ADR-0018's `opinionPublishHourUTC` is the
  intended knob. NOTE: this value is MDT-specific; if the box TZ or cron TZ ever changes, recompute so
  the Sunrise (04:00 local) run still lands in the (06:00 UTC, 10:00 UTC] window.
- **Caught up today (manual, bypasses the hour gate by design):** `npm run opinions -- --date
  2026-07-14` generated the missing **news pair — larry ("The Musk Voter Premium") + cynthia ("The
  Clock Stops for No Critic")**. The **gate ran via TTS** (healthy), passed 5/10 candidates, correctly
  excluding death/violence stories. Then `npm run images` → `npm run render` → `vercel --prod --yes`
  (deploy exit 0). Used `--date 2026-07-14` so tomorrow's `2026-07-15` slot stays untouched for the
  04:00 Sunrise run.
- **Priscilla preamble bug (this morning's cycle):** her `opinion-priscilla-2026-07-14` headline was a
  leaked model preamble ("I see the task: write one reader-letter column as Priscilla…") with the real
  column ("Wisdom's Moat") pushed into the body — a one-off Haiku artifact (larry/cynthia were clean).
  Fixed by deleting that record and regenerating (`--authors priscilla --date 2026-07-14`) → clean
  "Guard Your Casseroles". **Latent fragility — now FIXED** (see the parser-hardening entry at the top
  of this file): the piece parser used to take line 1 as the title with no preamble guard. It now
  strips leaked meta-preamble / `---` HRs and fails closed on refusals via `src/sanitize.ts`. Manifest
  backed up to the session scratchpad before the delete.

## Absolute timestamps (kill the stale "· X ago") + live cycle run after TTS upgrade

Owner report (2026-07-14): Priscilla's column went live ~90 min earlier but a fresh incognito load
still read `· 1 min ago`, while older opinion pieces read `· 1 day ago`. **Root cause:** the byline
"X ago" label was a *relative* string computed **once at build time** from `record.firstSeen` and
frozen into the static HTML — there is no client-side updater, so the freshest piece's "1 min ago"
was baked in during that build's render step and can't advance until the next render+deploy. Not a
reset; just inherently stale in a build-once static site.

- **Fix = absolute timestamp, no JS** (owner choice over a client-side updater).
  - `src/render/format.ts`: `relativeTime(iso, now)` **removed**, replaced by
    `formatTimestamp(iso, timeZone="UTC")` → `Intl.DateTimeFormat` `Jul 14, 2:30 PM` (month/day so
    multi-day pieces are unambiguous). Hermetic, mirrors `formatMastheadDate`. Empty/unparseable →
    `""` (no byline tail). An absolute instant never goes stale between deploys.
  - `src/render/index.ts`: `toStoryView`'s unused `now: Date` param → `timeZone: string`; it now
    calls `formatTimestamp(record.firstSeen ?? "", timeZone)`. `renderSite` passes the already
    resolved `tz` (the same `render.timeZone` feeding the dateline/edition). `articleToStoryView`
    keeps `timestamp: ""` (local articles show no stamp).
  - `src/render/templates.ts`: `StoryView.ago` → `timestamp`; `bylineTail(ago)` → `bylineTail(timestamp)`.
    Markup (`· <stamp>`) and the empty→no-tail behavior unchanged.
  - Tests: `test/render.test.ts` relativeTime cases → `formatTimestamp` cases (zone-explicit exact
    string; empty/garbage → "").
- **Verify:** `tsc` clean; **`npm test` 756 pass / 1 skip**.
- **Live cycle:** ran `scripts/cycle.sh` with the fix in the working tree (TTS server-side upgrades
  are done). RESULT: finished OK in 139s (deploy exit 0). Ingest 24 new; **generate 10 newest-first
  + imaged** → the lead refreshed. **No `TTS-DEGRADED` line — TTS healthy post-upgrade** (story-cover
  ran through it with zero failover). Cover now shows **absolute stamps** varying by `firstSeen`
  (`Jul 11`–`Jul 14` spread; the 8 freshest = `Jul 14, 6:31 PM`), never "X ago". **Opinions stage
  SKIPPED — `before publish hour (0 < 13 UTC)`**: opinion pieces are gated to a daily publish hour
  (13:00 UTC / 07:00 MDT), and the run happened at 00:31 UTC, so **no news-opinion this cycle by
  design** (not a bug). The next cycle at/after 13 UTC will generate them, and the newest-first fix
  now keeps the 24h candidate window full so larry/cynthia won't be starved again.

## Frozen-lead + missing news-opinion fix: newest-first generation, deploy exit-code, TTS failover + LOUD reporting

Diagnosed a 2026-07-14 report: afternoon cron published only Priscilla's letters column (no news
opinion) and the homepage lead didn't refresh. **Both symptoms had ONE root cause** — the
generate/image pipeline couldn't keep up with ingest, so the newest *publishable* story was ~28h
old. The lead is the newest publishable by `firstSeen` (frozen), and news-opinion candidates are
*publishable* stories in the last 24h (empty → both news columnists skipped; letters bypass the
pool). The opinion-gate never even ran (`gate not run (no candidates)` in the log) — the earlier
"gate failed closed" theory was **wrong**.

- **Newest-first generation** (`src/generate.ts`): the eligibility loop was `Object.keys(...)`
  insertion order = OLDEST-first, so the 10/run budget (`maxStoriesPerCycle`) was always spent on
  yesterday's backlog. Now sorts pending by `firstSeen` **desc** → the budget lands on today's
  newest stories; old un-generated stragglers age out (correct for news). Real-manifest sim proved
  it: OLD picks `2026-07-13T18:00`, NEW picks `2026-07-14T22:00`. The lead + the 24h opinion window
  both track "now" again on the next cron cycle. **No `maxStoriesPerCycle` bump** (owner choice).
- **resolveUrl/dedup: investigated and DROPPED.** The "duplicate inflation" theory was disproven —
  520 manifest records, **520 distinct titles, zero dupes**. Dedup works; the Google-News wrapped
  URL is stable-enough per article. `35 new, 3 known` is real feed velocity, not re-ingestion.
  `resolveUrl` returning the wrapped URL is cosmetic (outbound link still redirects), and a real
  decoder needs fragile Google `batchexecute` (POST — the `FetchLike` type can't even do it). Not
  worth the risk for zero symptom benefit.
- **Deploy exit-code propagation** (`src/cycle.ts`): a deploy that RAN and failed returned
  `ok:true` (the noon 18:00Z run logged `deploy: FAILED (exit 1)` yet `cycle finished OK (exit 0)`
  — stale site 12:06→16:06, invisible). Now `status==="failed"` → `ok:false` / `failedStage:deploy`
  → non-zero exit (benign skip/refuse states still exit 0). `cycle.sh` already passed the code
  through. Test added.
- **TTS: keep enabled, but retry → fail over → REPORT LOUDLY** (owner directive; they had no idea
  TTS was degraded). "G434" is **this PC**; `text-transform-service` (single-worker uvicorn :8712)
  was UP all day but returned 503 `busy` (concurrent burst vs one worker) and `model_unavailable`
  (its Ollama model gets unloaded by a co-tenant app's `cast-mentions` transform). The pipeline
  logged `unreachable` and **silently** failed over to Claude.
  - `src/generator/tts.ts`: `TtsClient` gained bounded **retry** (`retries`, short backoff) + a
    `TtsFailure` **observer** fired once per final failure (task, status, code, attempts).
  - `src/opinions.ts`: the gate now **fails OVER to the incumbent Claude gate** (still a real
    safety classification — pre-ADR-0022 behavior) instead of fail-closed; only if BOTH fail does
    it fail closed. `gateSummary` now records `via TTS` / `via Claude (TTS failover)`.
  - `src/cycle-cli.ts`: aggregates all TTS failures → a greppable `⚠ TTS-DEGRADED …` line +
    best-effort `notify-send`. Also a **config-gated preflight restart** (`restartCommand`) run
    once when TTS is unreachable at cycle start.
  - Config (`src/config.ts` + `config.example.json`): new optional `generator.tts.retries`
    (non-neg int) + `restartCommand` (non-empty string), validated.
- **Box config.json (gitignored):** set `generator.tts.retries: 2`. **Left `restartCommand`
  UNSET** — tested `systemctl restart text-transform-service` as user `kb`: it **hung ~25s on
  polkit then failed** (`Method call timed out`, same PID). The cron user can't restart the system
  unit without a privilege grant, and a hanging command would stall preflight. To enable later: a
  polkit rule or NOPASSWD sudoers line + `restartCommand: "sudo -n systemctl restart
  text-transform-service"` (see `docs/CONFIGURATION.md`).
- **Server-side follow-up (separate repo `text-transform-service`):** the durable fix for today's
  actual failure (503 busy / model eviction) is server-side — a request queue/concurrency limit +
  pin/keep-alive the model so a co-tenant can't evict it. A ready-to-paste Claude Code prompt was
  handed to the owner. Client-side retry+failover+report is the safety net, not the cure.
- **Verify:** `tsc` clean; **`npm test` 755 pass / 1 skip** (+ new generate-ordering, deploy-fail,
  gate-failover×2, retry, observer tests). Real dead-endpoint check: gate → null (→ Claude
  failover), observer captured `attempts:2`, ~518ms (retry backoff). `notify-send` present on box.
  **Not run: a full real cycle** (heavy, spends Grok, deploys) — the next cron cycle picks up
  newest-first and unfreezes the lead automatically.
- **Delivery:** landed on master per the standing no-PRs directive. Code changes committed; the
  `config.json` edit is gitignored (box-only). No open instruction issue (direct owner report), so
  no issue-close protocol.

## TTS per-task timeout → opinion-gate ENABLED; TTS rollout COMPLETE (ADR-0021 amendment)

Opinion-domain + client-seam slice. The TTS client applied one hard **30 s** budget to every
call; that starved the **fail-closed `opinion-gate`**, which runs a single constrained batch
classification (~34 verdicts) on the LAN 9B — inherently **~42–46 s**. A 30 s abort → fail-closed
→ every news-opinion candidate excluded that cycle. Prior verify proved the gate otherwise returns
safe, id-set-equal verdicts; latency was the only blocker. Owner chose option (b): a per-task
timeout override (not a TTS-side speedup — that means a model downgrade on a safety task, or
chunking with no net saving).

- **Per-task budget** (`src/generator/tts.ts`): new `resolveTtsTimeout(task, overrides?)` — shared
  `DEFAULT_TTS_TIMEOUT_MS = 30_000`, but `opinion-gate` → `DEFAULT_TTS_GATE_TIMEOUT_MS = 120_000`.
  `TtsHttpRunner` args gained optional `timeoutMs`; `defaultTtsRunner` uses it (or the 30 s default);
  `TtsClient` gained an optional 3rd ctor arg `timeouts?` and resolves the budget in `run(task)`.
  **Fail-closed posture unchanged** — a genuine timeout still aborts to excluded-all.
- **Config** (`src/config.ts`): optional `generator.tts.timeoutMs` map (keys = routable tasks,
  values = positive-int ms) overrides the code default per task; absent → code defaults. Validated
  (unknown key / non-positive / non-object rejected). Wired at both `new TtsClient` sites
  (`src/generator/index.ts`, `src/opinions-tts.ts`).
- **Tests**: per-task budget assertions (gate 120 s, others 30 s; override wins) + real
  `defaultTtsRunner` abort behavior via fake timers (45 s resolves under 120 s; 125 s aborts →
  fail-closed) + config cases. tsc clean; full suite **749 passed / 1 skipped**.
- **ADR-0021** amended (2026-07-14): why 120 s, why not a TTS-side speedup, posture unchanged.
- **Gate ENABLED (thread CLOSED)**: registry confirmed `opinion-gate` 0.3.0; re-verified at real
  reconstructed volume (newest 34 publishable non-op no-author, 13.7 KB) through the **real default
  runner** → **200 in 46.5 s (< 120 s budget, no abort)**, raw id-set exactly equal (34/34), 29
  eligible / 5 excluded, all 5 death/obituary stories excluded, **0 unsafe inclusions**. Flipped
  gitignored `config.json` `opinionGate: false → true` (no commit — config is gitignored). **All
  three routable TTS tasks now LIVE on cron**; `opinion-piece` held permanently.
- **NOT touched**: gate prompt/semantics, story-cover/brief adapters, personas, retention, deploy.
- **Delivery**: landed on master per the standing no-PRs directive. **Code-only change** (the enable
  is a gitignored config flip) — no render/deploy needed; the gate takes effect on the next real
  opinion cycle (it will block ~46 s once per run, by design). No open instruction issue existed for
  this cycle (direct owner directive), so no issue-close protocol was run.

## Slot-based hero eligibility: pay Grok only for encounterable heroes (ADR-0020)

Image-stage + display-bound slice. Grok spend is entirely the image stage (text is
Haiku), and it imaged EVERY generated non-opinion story regardless of visibility — plus
the cover overflow and section listings were unbounded, so there was no real slot. Now
we image (and list) only the top-K of each section that a reader can encounter.

- **One shared constant** in the new pure `src/eligibility.ts`:
  `SECTION_SLOT_LIMIT = 30` is BOTH the image budget and the render display bound (can't
  drift), plus `HERO_MIN_LIFETIME_HOURS = 12`. Code constants (like `HERO_FILL_COUNT`),
  not config — they encode the image==display invariant.
- **Eligibility (`heroEligibility`)**: a non-opinion story earns a hero iff it ranks in
  the top-30 of its section (newest-first `firstSeen`, competing against ALL live stories
  imaged-or-not — already-imaged records occupy slots) AND has ≥12h life left
  (`retentionHoursFor` on `lastSeen` — a READ of retention, no change). OPINION exempt
  (always imaged). Recomputed fresh each cycle; no persisted skip state. Precedence:
  below-fold before near-ageout.
- **Image stage** (`src/image.ts`): candidate loop replaced by `heroEligibility` over the
  post-reclear manifest; `ImageResult` gains `belowFold` + `nearAgeout`. Summary line is
  now `N generated, N skipped-below-fold, N skipped-near-ageout, N failed`. `maxStoriesPerCycle`
  cap + newest-first ordering unchanged.
- **Render** (`src/render/index.ts`): `sectionSlotIds(records, SECTION_SLOT_LIMIT)` filters
  BOTH the cover overflow and section grids (homepage + section agree). Landing pages,
  sitemap, and columnist archives keep the FULL record set. `verifiedPublishableRecords` /
  the deploy guard's `records.length` are untouched.
- **Dry-run mirror** (`src/cycle.ts`) derives its counts from the same `heroEligibility`.
- **NOT touched**: provider config, opinions/gate, generate stage, personas, retention
  semantics, cadence, deploy.
- **Verification**: tsc clean; full suite green (685 tests, +21: new `test/eligibility.test.ts`
  plus image/render/cycle additions). Dry-run cycle prints the new line. Real-manifest
  simulation: display cap trims 64 current below-fold stragglers (33 WORLD, tails elsewhere)
  from listings — intended tail-only change, top-30 above the fold identical; and a
  hypothetical "all live records need an image" run reports 218 eligible / 201 below-fold,
  i.e. ~half the manifest's would-be spend eliminated. `218 eligible == 218 listed` confirms
  image budget == display.
- **Delivery**: landed on master per the standing no-PRs directive. **NOT yet deployed** —
  the next real cycle (or a manual `vercel --prod` from `site/` with `cron.env` sourced) will
  render the display cap live; watch the Grok panel across a few cycles for the burn drop.

## Columnist bio pages: author pages, byline links, cast strip (ADR-0019)

Render-only slice; generation/selection/rotation/config/disclosure constants untouched.

- **Bio pages**: one per loaded persona at `columnist/<name>.html`, ALWAYS rendered
  (static content, no retention; empty archive shows "No recent columns…", never hides
  the page). Standalone landing-page chrome (`../` asset prefix + brand header — a
  deliberate divergence from about.html's full nav, recorded in the ADR). Body: the
  256×256 headshot at full size, display name, column title (letters), human-written
  `bio` paragraphs with `byline_blurb` fallback, and an archive of the persona's
  currently-live OPINION pieces as cards.
- **Optional `bio` front-matter** (`src/personas.ts`): inline `bio: text` = one
  paragraph, or bare `bio:` + indented lines = one paragraph each. Absent → blurb
  fallback; empty block or re-declared bio → parse defect. Human-written only — the
  pipeline never generates bio copy. Runbook's add/punch-up sections document it. None
  of the committed personas carry one yet (blurb fallback is live everywhere).
- **Byline links**: avatar + name in every opinion byline row link to the bio page.
  Opinion cards moved the byline row OUT of the card-wide anchor to a `.story` sibling
  (nested anchors are invalid HTML — share-row precedent); links carry a `pathPrefix`
  ("" root, "../" under `s/` and `columnist/`) so everything works over file://.
  Unknown-author records degrade to the old linkless row.
- **Cast strip** on opinion.html between the disclosure banner and the grid: every
  loaded persona, alphabetical, own `cast-strip__*` classes.
- **Meta**: bio pages emit `og:type=profile` (new `ogType` param on `cardMeta`,
  default "article"), description = `opinionMetaPrefix(displayName) — byline_blurb`
  (prefix first), `og:image` = the Blob avatar URL; a missing headshot entry omits the
  tag and warns. Sitemap gains one URL per persona. Homepage stays opinion-free.
- **Stale cleanup**: retiring a persona leaves its bio page on disk (the file map
  can't see roster removals), so both writers (`render-cli.ts` and the cycle's
  `writeSite`) readdir `columnist/` and delete non-emitted pages via the pure, tested
  `staleColumnistPages` helper. The rm loops themselves are untested, mirroring the
  existing stale-section deletion.
- Landed on master per the standing no-PRs directive. **Deployed 2026-07-13** at the
  owner's request (`vercel --prod --yes` from `site/`) — bio pages, byline links, cast
  strip, and sitemap entries verified live on www.brickfeed.news. Cron launcher still
  disabled by rename.

## Opinion operations: publish-hour gate + OPINION-STALE health + runbook (ADR-0018)

**The Opinion infrastructure phase is COMPLETE.** This final slice closed the two
operational gaps: pieces publishing at ~6 PM Denver the previous evening (first cycle
after 00:00 UTC), and tolerant-by-design failure degrading invisibly until the
empty-section rule hid the page.

- **Publish-hour gate**: the CYCLE's opinions stage runs only when
  `getUTCHours() >= opinionPublishHourUTC` (new config key, integer 0–23, default 13
  ≈ 7 AM Denver, invalid fails loud). `>=` never `==`, so a missed 13:00 tick
  self-heals at 14:00. A gated cycle makes ZERO provider calls (gate sits before
  `loadPersonaAssets` in `src/cycle.ts`) and reports
  `skipped — before publish hour (12 < 13 UTC)`. Direct `npm run opinions` bypasses
  the gate by construction (it lives only in the cycle stage). Dry-run prints the
  gate decision. The real box config gained `"opinionPublishHourUTC": 13`.
- **Structured health**: `OpinionsResult` gains `gateSummary`; the stage line is now
  `N published, N skipped, N failed; gate …`, and the cycle logs one JSON outcome line
  per run — `{"status":"ran"|"skipped-hour","published":[…],"skippedIdempotent":[…],
  "failed":[…],"gateSummary":…}` (`opinionsStageOutcome`).
- **OPINION-STALE alarm**: `opinionStaleness(manifest, now)` runs EVERY cycle
  (skipped-hour, all-idempotent, and dry-run included), after the pipeline so a
  recovery publish clears it the same run. Newest OPINION record older than 36h — or
  zero records — logs `cycle: OPINION-STALE — … threshold 36h`. The threshold is a
  constant (`OPINION_STALE_THRESHOLD_HOURS`), not config: it encodes the seven-day
  letters-schedule invariant (≥1 piece/day even on an all-tragedy news day).
  **Future work: alerting beyond logs** — no notify/webhook seam exists in the repo,
  so the loud greppable line is the current deliverable.
- **Runbook**: `docs/opinion-runbook.md` — normal-state description, the two knobs,
  manual runs (CLI bypass), OPINION-STALE triage order (provider auth → fail-closed
  streak → schema tests), add/punch-up/retire persona, re-launch via
  `npm run opinions -- --authors all` (no purge CLI exists; manifest-drop + storage
  delete is the manual path).
- Landed on master per the standing no-PRs directive. **Not deployed**: infra-only
  change with no render-output diff; the on-box verification cycle ran with
  `--no-deploy`. The next manual/cron deploy picks it up incidentally (the cron
  launcher is still disabled by rename on the box).

## Ad rotator rebuild + byline sizing + cache-busted CSS (ADR-0017)

Fixed the three live-site defects reported 2026-07-13 (giant stacked byline avatars,
fixed ad order, columnist ads flashing past). Diagnosis on the box: the avatars' CSS and
the rotator's timing both lived ONLY in `styles.css`, which is served with
`max-age=86400` and was linked with no cache-buster — a browser holding day-old CSS
against fresh HTML got natural-size avatars (no `.byline-opinion__avatar` rule yet) and,
because the old rotator was build-time keyframes generated PER AD COUNT, the 18-ad CSS
gave the 8 new columnist slides no `animation-delay` at all (all synced to slot 1,
topmost visible, rest flashing). Audit finding: NO ad assets were missing — all 26
sidecars valid, all 26 images 200 at the live origin.

- **Rotator is now client JS** (`src/render/rotator.ts`): pure `shuffleIndices`
  (Fisher-Yates) + `buildAdQueue`, unit-tested and embedded into the shipped inline
  script via `Function.prototype.toString()` (one definition). Shuffles once per page
  load, cycles the queue with `setTimeout` per-slide, toggles `.is-active`
  (0.9s opacity transition = the crossfade); frame gets `.is-live`. No JS /
  reduced-motion / single ad → static first slide via `:not(.is-live)` fallback.
  `adAnimationCss` is DELETED — styles.css is fully static now.
- **Sidecars are strict** (`parseAdSidecar` in `src/ads.ts`, personas-style): URL line
  required; optional `duration: <seconds>` bounded 2–60 (default 7s; `AdView.durationMs`
  → `data-duration`); present-but-invalid DISQUALIFIES with a named warning. A `.md`
  missing its image half now warns by name (image without `.md` stays the silent
  "parked creative" state). Contract documented in docs/ADS.md.
- **`styles.css` is cache-busted**: `pageShell` links `styles.css?v=<hash>` (content
  hash via the existing `hashString`; stable across renders of an unchanged sheet).
  This kills the whole stale-CSS failure class.
- **Byline avatars**: `width="48" height="48"` presentational attributes (survive stale
  CSS, reserve layout) + 48px hard-edged square with the photo border (house thumbnail
  convention; the 50% circle was an outlier). Piece pages get row whitespace via
  `.landing .byline-opinion`. Card + piece markup pinned by tests.
- **Box-verified**: real render (266 stories, ZERO ad warnings for the 26 real ads);
  headless Chrome runs — 4 page loads showed 4 different first ads (shuffle works),
  exactly one `.is-active` slide after 16s virtual time (timer chain advances), 48px
  inline avatar rows confirmed in screenshots on opinion.html and a piece page.
  Disclosure greps unchanged; LEGO grep clean. 627 tests / 40 files, tsc clean.
- Landed on master per the standing no-PRs directive; deployed to production manually
  at the owner's request (the cron launcher was disabled by rename on the box).

## Opinion render + imagery: heroes, cards, piece pages, disclosures (ADR-0016)

The Opinion section is now FULLY VISIBLE end to end. Launched on the box 2026-07-13:
the 8 image-less burn-in records were purged (store's own removal path), the launch
batch re-ran fresh (8/8 published WITH image briefs), `npm run images` stored all 8
heroes on Blob, and `npm run render` produced `opinion.html` + 8 piece pages with every
disclosure surface in place. The rendered `site/` is verified; the next cron cycle
deploys it (cron untouched).

- **Generation now emits the hero brief** (`src/opinions.ts`): after a piece passes its
  length check, ONE extra JSON completion (`buildImageBriefPrompt`/`parseImageBrief`)
  yields `{imagePrompt, caption}` in the story convention (purely visual, no
  text/brands, not pre-stylized; subject = the piece's topic, never the author);
  the record stores `imagePrompt` + `wrappedPrompt` (via `wrapBrickStyle`) + `caption`
  all-or-nothing with the piece. A failed brief fails that author and stores NOTHING —
  the key stays free, next run retries (piece regenerates; accepted, ADR-0016 d.2).
  Invariant: *stored opinion record ⇒ has wrappedPrompt + caption* — so the image stage
  picks pieces up with zero special-casing and `isPublishable` (which requires caption!)
  passes once the hero lands. `runOpinions` now takes `config` as its first param.
- **Cycle order changed (ADR-0016 d.5)**: ingest → generate → **opinions** → image →
  ageout → render → deploy. Opinions sits INSIDE the pipeline array, internally tolerant
  (its run() never throws), so a piece written at 06:00 heroes and publishes the same
  cycle via the image stage's existing writePublished.
- **Render (`src/render/`)**: `author`-bearing records get `local: true` views — internal
  `s/<id>.html` links, body = `paragraphize` (escaped plain text, NEVER markdown),
  card/meta description = `excerpt(…, 240)` (both new pure helpers in `format.ts`).
  `buildAuthorDirectory(personas, headshotManifest)` (render/index.ts) resolves the
  byline rows: avatar (28px circle from `data/headshots.json`) + display_name +
  column_title for letters; missing entries degrade with a warning via `opts.log`,
  never break the build. Homepage cover FILTERS opinion views (only exclusion needed —
  section pages isolate by kicker; sitemap deliberately KEEPS opinion URLs, d.4).
- **The four disclosure surfaces are versioned constants in `templates.ts`, pinned by
  render tests as merge gates**: `OPINION_BANNER` (on opinion.html), per-piece
  `byline_blurb` footer, `LETTERS_DISCLOSURE` (single definition, letters pieces only),
  `opinionMetaPrefix` leading every piece's og/twitter description +
  `OPINION_META_DESCRIPTION` on opinion.html (the ONLY section page with a meta
  description — byte-parity for the rest is a test). Changing any wording = ADR change.
- **Box-verified**: 8/8 published 316–597 words (tom in his 500–700 override); all 8
  briefs + heroes + captions present; banner, avatars, column titles, blurbs, letters
  line, leading meta prefix all confirmed in the rendered HTML; homepage has zero
  opinion content but nav links Opinion; sitemap gained opinion.html + 8 piece URLs;
  LEGO grep clean; world.html vs previous render differs only by nav + story count.
  600 tests / 39 files, tsc clean.
- The `generateAll` author-exemption (the ADR-0015 clobber guard) is now belt-and-braces
  (opinion records read as fully generated) — kept anyway.
- Landed directly on master per the standing no-PRs directive.

## Opinion generation stage: authors, gate, selection, idempotent publish (ADR-0015)

The stage that writes opinion pieces now exists and is LIVE — the launch batch ran on
the box on 2026-07-13 (`npm run opinions -- --authors all`): eight OPINION records are
in `data/manifest.json` under `opinion-{author}-2026-07-13` keys. They are image-less
and therefore unpublished (`isPublishable` requires `imageUrl`) — invisible on the site
until the render/imagery cycle. No render, config, or cron changes (cron's hourly cycle
now includes a tolerant opinions stage automatically).

- **`src/opinions.ts` is the whole stage** (pure helpers exported): `authorsFor` =
  ADR-0013 rotation pair (`daysSinceUnixEpoch % 3`) + ADR-0014 letters-schedule overlay;
  candidates = publishable non-OPINION records `firstSeen` <24h; ONE batched fail-closed
  topic-gate classification per run (strict JSON verdicts, any deviation → all excluded,
  news authors skip, letters unaffected); bias-weighted sampling (floor 0.25 for
  unlisted sections, 3 picks, `sourceArticleIds` persisted); output = title line + body
  → `headline`/`description`; length sanity per persona (default 300–500, tom 500–700,
  constants drift-pinned to the .md prose by tests; >2x out of band fails, out of range
  warns); idempotency checked BEFORE any provider call; per-author failure isolation
  (serial); CLI exit ≠ 0 only if ALL authors failed.
- **Record shape**: `id` = the idempotency key (NOT a URL hash — the store doesn't
  care), `url`/`sourceName` empty, `title` = headline, `firstSeen` = `lastSeen` = now
  (so `opinionMaxAgeHours` retention works unchanged), plus new optional
  `ManifestRecord` fields `author` / `columnTitle` / `sourceArticleIds`.
- **CRITICAL guard (`src/generate.ts`)**: `author`-bearing records are exempt from
  `generateAll` eligibility. Image-less opinion pieces read as "pending" to
  `isGenerated` — without the guard the next cycle would overwrite every piece with
  story-style output and then image it. Verified live: 114 records lack full generation
  fields, the cycle counts 106 pending (the 8 pieces excluded).
- **Cycle**: stage order was ingest → generate → image → ageout → **opinions** →
  render → deploy (SUPERSEDED by ADR-0016 — opinions now runs before image, see the
  section above); opinions is tolerant like headshots (never fails the run). Cycle
  dry-run prints a derivation-only "would" line (no provider calls); the standalone
  `npm run opinions -- --dry-run` DOES make the one gate call (verdicts must print)
  but zero piece calls and zero writes. `--authors all` = launch batch; `--date` moves
  derivation+keys only (never the candidate window; no backfill).
- **Verified on the box**: dry-run printed 8 authors + 42 gate verdicts (7 excluded:
  casualties/shooting/disaster/obituary — the gate works) + selections, zero writes;
  real run published 8/8 (news 373–479 words, priscilla 362, tom 602 — all in range,
  in register); re-run → 8 idempotent skips at zero provider cost; non-OPINION records
  byte-identical before/after; LEGO grep clean. 573 tests / 39 files, tsc clean.
- **Render/imagery contracts**: DELIVERED by ADR-0016 (see the section above) — card
  excerpting, byline rows, column titles, disclosure footers, and hero briefs all live.
- Landed directly on master per the standing no-PRs directive (see Git state below).

## Reader-letter columns: Tom & Priscilla assets, schema source split, bench letter mode

Implements ADR-0014 (assets/schema/bench only — no generation pipeline, no render, no
config, no cron). Landed directly on master per the owner's instruction ("no more PRs"),
after remediating the second stranded-PR incident (see "Git state" below).

- **Schema (`src/personas.ts`)**: required `source: news | letters` on every persona.
  `news` → non-empty `selection_bias` required, `schedule`/`column_title` forbidden.
  `letters` → `schedule` (slash-separated lowercase `mon..sun`, validated strictly, no
  duplicates → `Weekday[]`) + `column_title` required, `selection_bias` forbidden. All
  violations → `parsePersona` null, same strict style. New exports: `PersonaSource`,
  `WEEKDAYS`/`Weekday`, `LETTERS_PERSONA_FILE`.
- The six news personas gained EXACTLY one front-matter line each (`source: news`);
  their human-edited voice bodies are untouched — keep it that way.
- **New assets**: `personas/_letters.md` (letter-invention guardrails, prepended after
  `_shared.md` for letters personas; replaces only the "react to source articles" rule),
  `personas/tom.md` (Tom's Tech Corner, mon/wed/fri/sun, 500–700 words — the length is
  the bit), `personas/priscilla.md` (Dating, Life, and Love, tue/thu/sat/sun). Sunday
  double is intentional. Blurbs are human-owned copy, committed verbatim.
- **Bench letter mode** (`scripts/persona-bench.ts`): letters personas need no article
  inputs (article/letters-block loading is lazy per source, so `--persona tom` runs with
  zero fixture args); prompt = `_shared.md` + `_letters.md` + voice + letter task line;
  word count prints without the 300-500 verdict for letters (Tom's override). `--all`
  = six news over fixtures + two letters = eight pieces.
- **Future pipeline stage must branch on `source`** (articles vs letters prompt) and add
  the schedule overlay ON TOP of the ADR-0013 rotation pair — `opinion-{author}-{date}`
  idempotency keys already cover it. Letter pieces get one extra static disclosure footer
  line at render time; the copy is recorded in ADR-0014 decision 6.
- Verified: 531 tests / 38 files, tsc clean; box `npm run headshots` → "2 processed,
  6 skipped" with live Blob avatar URLs for tom+priscilla; bench `--all` → eight
  in-register pieces (six news in 300-500, Tom 613, Priscilla 397).

### Git state after this cycle (read before assuming PR flow)

PR #52 got stranded exactly like #50 before it (merged into the already-squash-merged
base `feat/opinion-personas-bench` instead of master). The owner directed: no more
delivery PRs — the stranded work was merged straight into master (merge commit,
bench side taken for the two squash-artifact conflicts, tree verified identical to the
bench tip) and pushed, and the merged remote branches `feat/opinion-personas-bench` and
`feat/opinion-retention-split` were deleted. This cycle's work was then committed on a
local branch and ff-merged into master directly, no PR. If PR flow resumes for future
cycles, avoid stacking on unmerged branches, or delete head branches on merge so GitHub
retargets stacked PRs.

## Opinion retention split: opinionMaxAgeHours (branch `feat/opinion-retention-split`)

Implements ADR-0013 decision 5: OPINION records retain for `opinionMaxAgeHours` (config key,
default 168h; absent → 168 in code, NEVER falls back to `maxAgeHours`; present-but-invalid
fails loud like every other config key), everything else keeps `maxAgeHours` (still 72 in
prod config — the cycle prompt's "48" was illustrative; `maxAgeHours` untouched).

- **`retentionHoursFor(category, config)` in `src/ageout.ts` is the single retention
  authority.** Both age gates route through it: the real sweep in `ageOut` (per-record
  window, boundary semantics unchanged: kept when `now − lastSeen <= window`, NaN kept)
  and `countStale` in `src/cycle.ts` (dry-run stage line parity). A grep for `3600_000`
  in `src/` must only ever hit those two lines — any third hit is a rogue gate.
- **Render needed NO change**: there is no age gate at render time; "live" IS manifest
  membership after ageout, and `presentSections` derives from presence. A longer opinion
  window is realized entirely by the sweep keeping records longer.
- The pinning test (`test/retention.test.ts`) guards the self-masking failure: under 2/day
  posting an unbranched sweep never empties the section (a fresh piece always masks it)
  while page depth silently caps at ~4 instead of ~14. Do not weaken it.
- `npm run ageout` now logs both windows. `docs/CONFIGURATION.md` documents the key.
  `config.json` (box-local) + `config.example.json` carry `"opinionMaxAgeHours": 168`.
- Verified: 517 tests / 38 files, tsc clean; live-store `npm run render` byte-identical
  before/after (206 stories → 224 files) — behavior-invisible until opinion content exists.
- **Merge order**: PR #51 (delivers the stranded #50 headshots work: it merged into
  `feat/opinion-personas-bench` AFTER that branch was squash-merged to master as #49, so
  it never reached master) → then this branch's PR (based on `feat/opinion-personas-bench`).
  First commit on this branch is the human's five persona voice edits, committed verbatim.

## Opinion headshots: idempotent optimize + publish step (branch `feat/opinion-headshots`)

Implements ADR-0013 decision 8 (+ a dated amendment: 256×256, i.e. ~128 px display at 2×
retina). Stacked on `feat/opinion-personas-bench` (PR #49, unmerged — this cycle needs
`loadPersonas`), so its PR targets that branch, not master.

- `src/headshots.ts` — hash-gated processing: sha256 of each `assets/headshots/<name>.png`
  vs its entry in the derived manifest `data/headshots.json` (`HEADSHOTS_MANIFEST_PATH`, a
  module constant like `ADS_DIR` — deliberately NOT config, per this cycle's "no config"
  scope; read degrades to empty, write is tmp+rename, same contract as `manifest.ts`).
  Changed/new sources are center-cropped square to 256×256 (`cropSquareAvatar` in
  `src/image/optimize.ts`, lossless PNG intermediate, null on undecodable input) and
  published via plain `storage.put("headshots/<name>", …)` — the SAME
  `withImageOptimization` chokepoint story images use performs the single WebP-q80 encode,
  landing at blob key `images/headshots/<name>.webp` (deterministic overwrite). Entry shape:
  `{ persona, sourceHash, avatarUrl, processedAt }`.
- Tolerance (ads/articles semantics, never throws): missing PNG → warn + `missing`;
  undecodable → `failed`; upload null → `failed`; in every case any EXISTING entry is
  preserved (the live avatar keeps rendering; a hash mismatch persists so the next run
  retries). Manifest written only when something processed — steady state is six hash
  checks, zero writes.
- Wiring: `npm run headshots [-- --force]` (`src/headshots-cli.ts`, fails loud on storage
  preflight); auto-invoked at the start of `render-cli.ts` and as a tolerant `headshots`
  cycle stage (after storage preflight, before ingest; never sets `ok:false`; dry-run
  prints a "would check persona headshots" line and provably does zero headshot IO).
  `CycleIo` grew a `processHeadshots` boundary (`fakeCycleIo` stubs it).
- **For render (cycle 6): resolve persona → avatarUrl via
  `readHeadshotManifest(HEADSHOTS_MANIFEST_PATH)`; a persona absent from the manifest
  simply has no avatar.**
- Box-verified: first run 6 processed + 6 entries with real Blob URLs; immediate rerun 6
  skipped; `--force` 6 processed; one re-encoded source → exactly 1 processed. Suite: 509
  passing / 37 files (E2E over the real PNGs is `describe.skipIf`-guarded; CI needs no
  assets and no network).
- Known limitations: entries for deleted personas are not pruned (orphan avatars would
  linger in Blob); toggling `image.optimize.enabled` doesn't change `sourceHash`, so a
  format change needs `--force`.
- Found in the working tree (NOT committed by this cycle): human edits to five persona
  worldview sections — left uncommitted for Kris to commit to PR #49.

## Opinion personas: voice assets + bench harness (branch `feat/opinion-personas-bench`)

The six ADR-0013 persona prompt assets now exist under `personas/` — `_shared.md` (the REGISTER +
GUARDRAILS block prepended to every opinion prompt; register decision since the ADR: personas are
over-the-top SELF-caricatures, the joke lands on the author, never on the people in the news) plus
`{alice,bob,edgar,stryker,larry,cynthia}.md`, each with front-matter (`name`, `display_name`,
`byline_blurb`, `selection_bias`) and a voice prompt (worldview / comedy engine / exaggeration
anchor / signature moves / hard rules). **The byline blurbs are human-owned draft copy committed
verbatim — flagged for edit.** No pipeline wiring, no site/config/cron changes, no publishing.

What landed in code:

- `src/personas.ts` — hand-rolled front-matter parser (`parsePersona`, strict: null on missing
  field, non-CATEGORIES `selection_bias` key, or bad weight — typos fail loudly, never launder
  into WORLD) + tolerant `loadPersonas` (log-and-skip, `_`-prefix excluded, front-matter `name`
  must equal the file basename). Mirrors `articles.ts`.
- `src/generator/text.ts` — free-form text seam over the SAME provider abstraction
  (`createTextGenerator(config)`: grok-terminal | claude | grok; transport-only, never-throw →
  null; `apikey`/unknown throws at factory time). Reuses the exported runners/extractors; the
  only existing-src edit was exporting `defaultRunner` in `subscription.ts`. **Next cycle's
  opinion pipeline stage should build on this seam** (nothing in the pipeline imports it yet).
- `scripts/persona-bench.ts` (`npm run bench:personas -- --persona <name> | --all`, plus
  `--fixtures <dir>` | `--recent <n>` | `--provider <p>`) — assembles `_shared` + persona body +
  article blocks, prints each piece with word count. Offline fixtures in `fixtures/opinion-bench/`
  (3 neutral fictional articles). `--recent` synthesizes blocks from `published.json`
  headline/description (the store keeps no article bodies).
- Tests: `test/personas.test.ts` (parser + loader + schema validation of the real committed
  persona files; headshot pairing under `describe.skipIf` since `/assets/` is git-ignored) and
  `test/generator.text.test.ts`. Suite: 484 passing / 36 files.

**Bench voice-read findings** (`--all` over the 3 fixtures, provider claude/Haiku): all six voices
clearly distinguishable and in-register; all deadpan (no in-body bot acknowledgments); all pieces
in the 300–500 word range on both runs. Alice and Bob read equally sharp — no observed political
thumb on the scale. Minor notes for future iteration: Edgar produced only one explicit "and
another thing" digression (spec wants stacks that never resolve), and 5 of 6 personas chose the
same fixture article (the streaming redesign) — topic spread will come from the pipeline's
selection_bias weighting, not the prompt. No persona-file edits were needed this cycle.

Still future per ADR-0013: the opinion pipeline stage (cadence, idempotency, topic gate),
`opinionMaxAgeHours` config, headshot optimize step, and rendering of opinion pieces.

## Opinion section: ADR-0013 + conditional section rendering (branch `feat/opinion-section-scaffold`)

The full Opinion-section design (six disclosed AI persona authors) is recorded as **ADR-0013**
(`docs/adr/0013-opinion-section-architecture.md`): pipeline-stage generation via the existing
`Generator` seam, `personas/*.md` prompt assets with front-matter (`name`, `display_name`,
`byline_blurb`, `selection_bias`; headshots by convention at `assets/headshots/{name}.png`, no
`avatar_seed`), stateless cadence (2/day, fixed pairs, `daysSinceUnixEpoch % 3`, skip-never-backfill),
idempotency key `opinion-{author}-{YYYY-MM-DD}` (UTC), retention via `opinionMaxAgeHours` (default
168, never inherits `maxAgeHours`), three static hand-written disclosure surfaces (page banner,
byline_blurb footer, Twitter Card description **prefix**), topic gate + content guardrails, and
layout reuse with byline-row/footer/banner deltas. **This cycle landed only the UI groundwork** —
personas, generation, headshot processing, config, and cron are all future cycles per the ADR.

What landed in code — **all section rendering is now data-driven** (ADR-0013 decision 9):

- `renderSite` computes `presentSections` once (feed records + live local articles, CATEGORIES
  order) and threads it through `sectionNav`/`footer`/`renderAbout`/`renderCover`/`renderSection`
  (all now take a `sections: readonly Category[]` param). A section with zero published items is
  omitted from the nav, the footer, the sitemap, **and no `<slug>.html` is emitted at all**. The
  two hard-coded `filter((c) => c !== "OPINION")` special-cases are gone; About is a permanent
  trailing nav link. `renderSection`'s empty-state branch is kept defensive-only.
- **Stale-page cleanup (found during verify, not in the plan):** `site/` is written incrementally,
  never wiped — so an omitted section's page from a previous render would linger and deploy. New
  pure helper `staleSectionPages(files)` in `src/render/index.ts`; both writers (`render-cli.ts`
  and `cycle.ts` `defaultCycleIo.writeSite`) now `rm` those files after writing. Verified against
  the real `site/`: the pre-existing stale `opinion.html` was deleted on the next `npm run render`.
- `OPINION` was already in `CATEGORIES` (`src/category.ts`) with a `SECTION_BLURBS` entry — no
  taxonomy change. Opinion appears automatically the day its first piece publishes.
- Tests: 6 render tests updated (per-section emission, nav, empty-section, empty-published, ads
  site-wide, sitemap) + new `describe("renderSite — conditional sections (ADR-0013)")` (Opinion
  visible with a record incl. nav ordering; a live article alone makes a section present; an
  expired article does not; `staleSectionPages`).

Verified: `npx tsc --noEmit` clean; **`npm test` 442 passing, 34 files**; real
`npm run render` (cron.env sourced) → 206 stories, populated sections all render unchanged,
no opinion links anywhere, stale `opinion.html` removed from `site/`.

---

## Switch text generation to Claude/Haiku (images stay on Grok) + the `--bare` fix that unblocks it (branch `fix/claude-bare-not-logged-in`, PR #44)

**Text** generation now runs on the **`claude` provider with Haiku** (`claude-haiku-4-5-20251001`);
**image** generation stays on **Grok** (`grok-terminal`). Grok is images-only now. Recorded as
**ADR-0011**. The switch is applied to the live (git-ignored) `config.json` and mirrored in the
committed `config.example.json`; the code-level default when the provider is omitted stays
`grok-terminal` (ADR-0007). Verified end-to-end: real `config.json` → `createGenerator` selects
`SubscriptionGenerator` → Haiku returns all five artifacts (~26s cold). CLAUDE.md's runtime-topology
/ pipeline / pluggable-generator notes updated to reflect the split.

> Operator note (from the switch request): the Grok subscription can run out of credit — when it
> does, **image** generation fails and stories sit unpublished until an image lands. Text (Claude)
> is unaffected. `image.provider` intentionally has no `claude` option.

This branch also carries the bug fix that made the switch possible at all:

Groundwork for moving **text** generation from `grok-terminal` to `claude` (Haiku by default) —
**image generation stays on Grok**. This **fixes a real bug that was blocking the switch entirely**
and lands the opt-in live test the operator asked for.

**The bug (fixed).** `src/generator/subscription.ts` spawned `claude -p --bare --output-format json`.
`--bare` ("minimal mode: skip hooks, LSP, plugin") also skips loading the stored subscription login,
so headless `claude -p --bare` returns `is_error:true` "Not logged in · Please run /login" **even on
a fully authenticated box** — `SubscriptionGenerator` then returns null for every story. So switching
`generator.provider: "claude"` would have silently left every story pending. (My previous handoff
wrongly blamed the environment / missing `CLAUDE_CODE_OAUTH_TOKEN`; that was wrong — the box is
authenticated; our own `--bare` flag was the problem. The working `photo-wrangler` app invokes
headless `claude` without `--bare`.)

- **Fix:** dropped `--bare`; the runner now uses `["-p", "--output-format", "json", "--model", m]`,
  extracted into an exported `buildClaudeArgs(model)` with a regression test asserting `--bare` is
  never present (`test/generator.subscription.test.ts`).
- **New `scripts/check-claude-generator.ts`** (`npm run check:claude`, `-- --model=<id>` to override;
  default `claude-haiku-4-5-20251001`). Drives the **real** `claude -p` CLI through the production
  `SubscriptionGenerator` (no injected runner) over 5 diverse stories, prints each of the five
  artifacts (headline/description/imagePrompt/category/caption) with HARD checks (non-null, all four
  text fields non-empty, category in taxonomy) and SOFT quality warnings (verbatim-title, word
  counts). Exits non-zero on any hard failure. Never greps for trademark strings (CLAUDE.md
  guardrail) — brand/text-in-scene review is left to the eyeball.
- **Not wired into `npm test`** (stays mock-first/offline). `scripts` is in `tsconfig.json` `include`
  so the harness is typechecked; usage + the `--bare` gotcha noted in `docs/CONFIGURATION.md`.
- The remaining switch is now genuinely config-only: the `claude` provider shares the exact prompt
  (`src/prompt.ts`) and parser (`src/generator/parse.ts`) with `grok-terminal`. Set
  `generator.provider: "claude"` + `generator.model` to the Haiku id, leaving `image.provider` on Grok.

Verified on the box (authenticated `claude` CLI): `npx tsc --noEmit` clean; **`npm test` 401 passing,
32 files** (2 new `buildClaudeArgs` tests); **`npm run check:claude` → 5/5 passed · 0 quality
warnings** with genuinely good Haiku output (original rewrites, correct categories, brick-diorama
image prompts, ~14–22s/story warm). Operator step: eyeball that output, then flip the config.

---

## Share sheet: LinkedIn button + section split + filtering, and `Sport`→`Sports` (branch `feat/share-linkedin-sections-filter`)

Operator-facing changes to the private `share.html` worksheet plus a taxonomy rename. All in the
pure render core (`src/render/*`) + data/tests/docs; no pipeline or config changes.

1. **"Post to LinkedIn" button per row.** New `buildLinkedInIntentUrl` in `format.ts` →
   `https://www.linkedin.com/feed/?shareActive=true&text=<headline>%0A%0A<pageUrl>`. Prefills the
   post body like X; LinkedIn resolves the landing page's OG tags to auto-attach the brick-image
   card (best-effort). No 280 budget / no via/hashtags — deliberately simpler than the X builder.
   Each row now renders both buttons inside a `.sharesheet__actions` group.
2. **Local articles pinned to their own top section.** `renderShareSheet` partitions rows by
   `view.local` into a **"Local articles"** section (top) then **"From the feed"**; empty sections
   (and their headings) are omitted. Ordering is now independent of push order in `index.ts` — no
   `index.ts` change.
3. **Client-side section filter.** A chip bar (`All` + one chip per category present, in
   `CATEGORIES` order, `titleCase` labels) with a small vanilla-JS IIFE that shows/hides rows by
   `data-category` and hides any section left empty. Fine on this `noindex` operator-only page.
4. **`Sport` → `Sports`.** Enum value `SPORT`→`SPORTS` in `src/category.ts` (label, `sports.html`
   slug, nav, prompt all derive from it); `SECTION_BLURBS` key renamed; migrated the 40 stored
   `"category": "SPORT"` values in `data/manifest.json` (25) + `data/published.json` (15) so
   `normalizeCategory` doesn't silently remap them to WORLD. Old `sport.html` bookmarks 404 (fine
   for a rotating hobby site; no redirect). Docs updated (`docs/ARTICLES.md`, this file).

Verified: `npx tsc --noEmit` clean; **`npm test` 399 passing, 32 files**; local `npm run render`
emits `share.html` with 140 X + 140 LinkedIn links, 8 filter chips (incl. SPORTS), and `sports.html`.
Deploy: per operator request this branch is merged to `master` (Vercel auto-deploys `brickfeed.news`).

---

## Docs refresh — ads + articles + stale-doc cleanup (branch `docs/refresh-ads-articles`)

Current state as of this entry:

- **Live** on **https://www.brickfeed.news** (the old `brickfeed-teal.vercel.app` URL in these
  docs was stale and has been corrected). Deploys are direct `vercel --prod --yes` from the box
  (ADR-0006), not git-push-triggered.
- **ADR-0009** (per-story `s/<id>.html` landing pages + X share sheet) is landed/Accepted.
- **ADR-0010 — locally hosted articles** is landed (branch `feat/local-articles`, PR #40):
  on-site original stories from `assets/articles/` with section, cover/section rank, expiry, and
  a hosted body page reusing `s/<id>.html`. Adds the `marked` dependency. Documented in
  `docs/ARTICLES.md`.
- **Banner ads** (`src/ads.ts`, `assets/ads/`) are now documented in the new `docs/ADS.md` (they
  had no docs before).
- Reference docs reconciled to the code: `docs/CONFIGURATION.md` (added `render.timeZone`/
  `siteBaseUrl`/`share`, fixed `maxStoriesPerCycle` default 20→40), `docs/ARCHITECTURE.md`
  (added `ads.ts`/`articles.ts`/`render/markdown.ts`, per-story + share output, 393-test count),
  `README.md` (URL, `marked` dep, docs index), `CLAUDE.md` (keyless `grok-terminal` default,
  CLI-direct deploy). Suite: **393 tests, 32 files**.

---

## Per-story landing pages + assisted-manual X share sheet (ADR-0009, PR pending)

Sharing a brickfeed story on X used to paste the **outbound source URL**, so X rendered the
*publisher's* OG card, not our brick art. This slice adds, entirely inside the pure render
core (`src/render/*`) + the two thin writers:

1. **Per-story landing pages at `site/s/<id>.html`.** `renderSite` now emits one
   social-card page per publishable record. `<head>` (new `cardMeta` in `templates.ts`):
   `twitter:card=summary_large_image`, `og:type=article`, `og:title`/`og:description`,
   `og:image`+`twitter:image`=the record's absolute Blob `imageUrl`, `og:url`=the page's own
   ABSOLUTE URL, and `twitter:site` **only** when a handle is configured. `<body>`: the brick
   image (shared `figure`), kicker, headline, dek, caption + `/ BRICKFEED STUDIO`, and a
   prominent outbound link to the source. Self-contained (lives in `s/`): a brand header, not
   the root-relative masthead/nav/footer, and `../styles.css` via a new `pageShell`
   `assetPrefix` hook.
2. **Assisted-manual share sheet at `site/share.html`** (new `renderShareSheet`): one row
   per story = thumb + headline + a **"Post to X"** button whose href is the X Web Intent
   URL (`buildXIntentUrl` in `format.ts`, built with `URLSearchParams`): `text`=headline,
   `url`=absolute landing URL, `hashtags`/`via` only when configured. Headline is
   length-budgeted under 280 (23 for the t.co URL) and truncated with `…`. `<meta robots
   noindex>`; NOT linked from the nav/footer. $0, no API, no scheduler — a human clicks.

- **Config (`src/config.ts`):** NEW `render.siteBaseUrl` (absolute, no trailing slash,
  validated; default `https://www.brickfeed.news`) — the only way to build absolute
  `og:url` + share URLs. NEW optional `render.share { handle?, hashtags? }` (handle stored
  without `@`, hashtags without `#`). `config.example.json`, `test/helpers.ts` `makeConfig`,
  `test/config.test.ts` updated.
- **Writers:** `defaultCycleIo.writeSite` (`cycle.ts`) + the `render-cli.ts` loop now
  `mkdir` each file's parent (the `s/<id>.html` keys carry a subdir); both threaded
  `siteBaseUrl` + `share`.
- Tests **365 passing** (+57). Gates clean: `tsc --noEmit`; `process.env` only in
  `secrets.ts`; `grep -rin lego src config.example.json` empty. Repo stays text-only —
  landing/share pages are gitignored `site/` artifacts; templates/CSS are committed source.
- **Verified end-to-end:** drove `renderSite` over the real 100-record `data/published.json`
  → 112 files (100 landing + `share.html` + the 11 chrome pages). A landing page's `<head>`
  carries the real Blob `og:image`, absolute `og:url`, `@brickfeednews` twitter:site, and
  `../styles.css`; `share.html` has 100 fully-encoded intent links (text+url+hashtags+via,
  `&amp;`-escaped), `noindex`, and is linked nowhere in the nav/footer (0 references).
- **NOTE (no tracking issue):** this cycle was driven directly (no open `instructions`
  issue), so there was nothing to comment/relabel — only the PR.
- **Box action:** set `render.siteBaseUrl` to the real live origin in the box `config.json`
  (it defaults to `https://www.brickfeed.news`); optionally set `render.share.handle` /
  `render.share.hashtags` to enable `via`/hashtags + `twitter:site`.

## brickfeed is LIVE on real Vercel Blob — image-existence gate + fail-loud preflight (issue #28, merged as PR #29 → master, commit 70c7528)

> **Current state (2026-07-10):** the image-existence-gate work below is merged to `master`
> (commit `70c7528`). Two docs/chrome follow-ups are in review as PRs, not yet merged:
> PR #30 (`chore/footer-tagline-and-dead-links`) replaces the Latin masthead/footer motto with
> the plain-English tagline "All the stories, brick by brick" and drops the dead footer links;
> and a repo-documentation PR (`docs/repo-documentation`) adds `README.md` +
> `docs/{ARCHITECTURE,INSTALL,CONFIGURATION}.md`. History below is unchanged.

**brickfeed now serves a live, fully-imaged page.** Live URL: **https://brickfeed-teal.vercel.app**
(Vercel project `brickfeed`, `site/` linked). Three things landed:

1. **Image-existence gate (no more broken frames).** `isPublishable` only checked that the
   `imageUrl` STRING was present — never that the artifact existed. Result before this cycle:
   **40 of 78 `<img>` were broken** (39 records carried stale local-scheme URLs; only 19 files
   existed). New never-throw **`StorageProvider.exists(id, imageUrl?)`** verifies the artifact the
   render will actually emit — local: `stat` size>0; blob: HEAD the exact stored URL → 200,
   short-circuiting a stale relative/foreign URL. `verifiedPublishableRecords` (src/publish.ts)
   layers it onto the pure field-gate and is the authoritative page source at
   `src/cycle.ts` render (and `writePublished`, threaded a `storage`). No dangling `<img>` renders.
2. **Clear + re-image (owner decision).** `generateImages` reconciles FIRST: any record whose
   `imageUrl` no longer resolves in the CURRENT store is cleared, so it re-images into that store
   (bounded by `maxStoriesPerCycle`). Heals provider switches (local→blob) and deleted/zero files.
3. **Deterministic, fail-loud, non-interactive preflight.** New **`StorageProvider.preflight()`**
   (a provider method — colocated with the provider, keeps the cycle tests hermetic) runs ONCE at
   the top of `runCycle`. Blob requires BOTH `BLOB_READ_WRITE_TOKEN` (env) and
   `storage.blob.publicBaseUrl` (config); local requires a writable dir. On failure the cycle
   ABORTS before ingest/generate with a single actionable stderr message + non-zero exit — never
   pays for images it can't store, never prompts. The old advisory warn in `createStorageProvider`
   was removed (superseded). `src/storage/index.ts` no longer reads env.

**Files:** `src/types.ts` (StorageProvider gains `exists`+`preflight`; `StorageFs` gains `stat`;
`StorageHttpRunner` method adds `"HEAD"`; `CycleIo.writePublished` gains optional `storage`),
`src/storage/{blob,local,index}.ts`, `src/publish.ts`, `src/image.ts`, `src/cycle.ts`,
`src/{image,ageout}-cli.ts`, plus test helpers + new tests. **Tests 308 passing (+20).** Gates
clean (`process.env` only in `secrets.ts`; no lego; `tsc --noEmit` clean).

**PROVEN end-to-end (not mocks):**
- **token UNSET →** `npm run cycle` aborts at `storage-preflight` with the exact fix message,
  exit 1, zero prompts, no generation.
- **token SET →** real keyless cycle (grok-terminal generation, no generation API keys):
  `ingest 12 new`, `generate 12`, `image: recleared 39 stale refs → 20 stored to real Blob, 0 failed`,
  `render 20 publishable`, `deploy: deployed (exit 0)` via `vercel --prod --yes` — **zero prompts**.
- **live site:** every `<img>` across all 9 pages resolves — **40/40 → 200 with non-zero bytes,
  0 broken** (images are honest `.jpg` on the Blob CDN). Was 40 broken of 78.

**Box config (gitignored, on-box):** `storage` block set to `provider:"blob"`,
`blob.publicBaseUrl:"https://7fjkp0rhcwadfro9.public.blob.vercel-storage.com"` (local block kept).
**A real run needs only `BLOB_READ_WRITE_TOKEN` in env** (the `vercel_blob_rw_…` secret — never
committed; put it in the box shell profile / cron env). `site/.vercel` links to the `brickfeed`
project; `vercel` is authenticated as `kbennett2000` (`vercel login` done). `vercel --prod --yes`
+ stdin-ignored deploy runner = non-interactive.

## Local storage now writes images INTO site/ with a resolving URL (issue #26, PR pending)

**Bug:** with `storage.provider=local`, a keyless run produced a `site/` where every `<img>` was
broken. Root causes: (1) the local default `dir` was `data/blob` — git-ignored and *outside* the
`site/` deploy artifact — with an absolute `http://localhost:8189/blob` `publicBaseUrl` that
doesn't resolve when Vercel serves `site/` statically (render emits `imageUrl` verbatim as the
`<img src>`); (2) the image stage hardcoded `image/png`, but grok emits **JPEG**, so files carried
the wrong extension; (3) `local.delete()` / `blob.delete()` reconstructed a hardcoded `.png` name,
so age-out couldn't remove a `.jpg` — orphaned artifacts.

**Fix:**
- **`src/config.ts` + `config.example.json`** — local defaults now `dir: "site/images"`,
  `publicBaseUrl: "images"`. `put` returns the RELATIVE URL `images/<id>.<ext>` — exactly what
  render emits and what resolves under the served site root. Images ship inside `site/`, so
  `vercel` (cwd `site/`) uploads them with the pages.
- **`src/image.ts`** — new `detectImageContentType(bytes)` sniffs JPEG/PNG/WebP magic bytes and
  passes the REAL content-type to `storage.put`, so the stored extension is honest (grok → `.jpg`).
- **`src/storage/local.ts` + `src/storage/blob.ts`** — `delete(id)` (which only gets the id) now
  targets every extension `put` can produce (`IMAGE_FILE_EXTENSIONS = .png/.jpg/.webp`): local
  unlinks each candidate; blob POSTs all candidate URLs in one request. No orphaned `.jpg`.
- Tests **288 passing** (+7): local JPEG round-trip + relative-URL shape, blob multi-ext delete,
  `detectImageContentType` unit tests, JPEG-content-type-through-the-stage. Gates clean
  (`process.env` only in `secrets.ts`; no lego).
- **PROVEN keyless (no API keys), real grok-terminal + local storage, 3 stories** via a scratch
  config through the real `runCycle` path (box `data/`/`site/` untouched): 3 generated + 3 stored
  as **`.jpg`** (256–359 KB, all non-zero) under `site/images/`; rendered `<img src="images/<id>.jpg">`;
  serving `site/` as web root, every image `GET` → **200 image/jpeg** with the exact byte count.
- **Box `config.json` (gitignored, on-box edit):** added a `storage` block set to `provider:
  "local"` with `dir: "site/images"`, `publicBaseUrl: "images"` (was: no storage block → defaulted
  to blob, which needs a token = not keyless). A real `npm run cycle -- --no-deploy` on the box is
  now keyless with zero manual edits.

## grok-terminal pipeline sped up: stage concurrency + cap + logging + timeout (issue #24, PR pending)

The cycle was slow because `generate` then `image` ran one grok CLI call per story, **serially**
(67 + 67). Investigation (measured on the box, keyless): **Chronicle has no faster/warm grok
path** — every Chronicle grok call is a fresh spawn, its grok text is ~116–151s and grok image
~15–20s, and its genuinely-fast images come from a **ComfyUI warm HTTP service**, not grok.
brickfeed's providers already match Chronicle's invocation. Per-call grok time is
**xAI-server-bound** (text ~5–6s, image ~13–15s, ~90% idle waiting), so the model/leader/boot
barely help. **The only material lever is concurrency** — overlapping the idle waits.

- **`src/pool.ts`** — `mapWithConcurrency(items, n, fn)`: bounded pool, results in input order,
  no deps. Unit-tested (`test/pool.test.ts`).
- **`src/generate.ts` / `src/image.ts`** — each stage now selects eligible IDs (in manifest
  order, capped by `opts.limit`), runs them through the pool at `opts.concurrency` (default 1 =
  serial), and applies results **in manifest order** so output is identical to serial
  regardless of finish order. All guarantees preserved (idempotency, all-or-nothing,
  never-throw, limit-as-attempt-cap). Per-story progress via optional `deps.log`
  (`generate 3/20 <id>: ok (5.1s)` / `… pending`).
- **Config** (`src/config.ts`, `config.example.json`) — `concurrency` (default **4**),
  `maxStoriesPerCycle` (default **20**, the per-cycle cap, reuses `opts.limit`), and optional
  `grokTerminal.timeoutMs` (per-call SIGKILL budget; defaults 120s text / 180s image, down from
  180/240). `cycle.ts` threads `{limit: maxStoriesPerCycle, concurrency}` + `log` into both
  stages; factories pass `timeoutMs` to the providers.
- Provider/runner INTERFACES unchanged except an added **optional** `timeoutMs` on the runner
  arg and `log` on the deps — all injected-runner tests hold. Tests **281 passing** (+15).
  Gates clean (`process.env` only in `secrets.ts`; no lego).
- **MEASURED, keyless (no API keys), real grok-terminal + local storage, 6 stories:**
  serial (c=1) **138.6s** (generate 55.0s + image 83.6s, 23.1s/story) → concurrent (c=4)
  **48.4s** (generate 15.1s + image 33.3s, 8.1s/story) = **2.86× faster**, 6/6 generated + 6/6
  stored, valid 340–400 KB images. A full 67-story run approaches ~4×.
- **Follow-up (noted, not done):** incremental per-story manifest persistence would make a long
  concurrent image run crash-resilient (today the stage persists once at the end).

## Box config migrated to keyless grok-terminal (issue #22, PR pending)

The box `config.json` (gitignored — not in the repo) predated the grok-terminal rename and did
NOT use the keyless path. Migrated in place, exactly two changes, everything else untouched:

- `generator.provider`: `"subscription"` → `"grok-terminal"` (was aliasing to the `claude`
  path, not keyless).
- added `"image": { "provider": "grok-terminal" }` (was absent → falling back to a default).

Storage was left untouched per the owner's decision: it defaults to Vercel **Blob**, which
needs `BLOB_READ_WRITE_TOKEN` (an env secret the owner sets), not config.

**Verified with the real box config, keyless** (`grok` CLI subscription login; `XAI_API_KEY`,
`ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN` all unset). Ran `npm run cycle -- --no-deploy`
against the box's grok-terminal + Blob setup, bounded to 2 stories via a local feed + scratch
manifest/site paths (so the live Google-News feed couldn't re-flood the manifest and the box's
real `data/`/`site/` were never touched — the real 67-story manifest was backed up and restored
untouched). Result:

```
warning: BLOB_READ_WRITE_TOKEN is not set; Blob storage will skip every story …
  • ingest:   2 new, 0 known
  • generate: 2 generated, 0 skipped, 0 pending      ← keyless grok-terminal TEXT works
  • image:    0 stored, 0 skipped, 2 failed          ← grok-terminal generated bytes; Blob
                                                        rejected the store (no token)
  • render:   0 publishable → 10 files
  • deploy:   skipped-flag        (exit 0)
```

Takeaways:
- **The keyless generation path is now the effective one.** `generate: 2` with **no
  `XAI_API_KEY` warning anywhere** — both text and image route through the subscription `grok`
  CLI, no API key. The provider-fallback bug is fixed on the box.
- **The only remaining gap to a fully-populated run is storage.** `image: 2 failed` is not a
  grok failure — grok-terminal generated the image bytes; `storage.put` (Blob) returned null
  because `BLOB_READ_WRITE_TOKEN` is unset (the warning names it). With `0` stored images,
  nothing is publishable, so `render` writes the site chrome but `0` stories.
- **To get `image stored > 0` + a populated `site/`:** set `BLOB_READ_WRITE_TOKEN` (and
  `storage.blob.publicBaseUrl`) in the box env — then a real cycle stores to Blob and publishes.
  (Prior cycle #20/#21 already proved the full pipeline end-to-end keyless with local storage:
  generate 2, **image stored 2**, render 2 publishable, valid images. Blob is the same
  `storage.put` seam behind a token.)

`config.json` stays gitignored (secrets/URLs never committed), so this HANDOFF note is the
committed record; the config edit itself is a box-local action.

## keyless grok-terminal is now the real default (issue #20, PR #21 merged)

The prod-keyless promise (ADR-0006 #7) was not actually in effect, and the grok-terminal
providers were built against contracts the real `grok` CLI does not honor. All three fixed
and **proven live, keyless** (no `XAI_API_KEY`, subscription CLI only):

- **Defaults flipped to keyless.** `DEFAULT_PROVIDER` and `DEFAULT_IMAGE_PROVIDER` are now
  `"grok-terminal"` (were `"grok"`, the xAI API-key paths); `config.example.json` matches. A
  fresh/legacy config resolves to the keyless path and never demands `XAI_API_KEY`. The
  `XAI_API_KEY` warning lives only on the API-key `grok` branch, which is no longer the
  default — so the keyless path is silent.
- **grok-terminal TEXT rebuilt** (`src/generator/grokTerminal.ts`). The real `grok` is an
  agentic *coding* CLI: it needs the prompt as the `-p <prompt>` value + `--output-format
  json` (NOT stdin) and returns a `{ "text": ..., "sessionId": ... }` envelope. New
  `extractGrokText` unwraps `.text`, then the shared `parseGeneratorOutput` runs. The default
  runner cages grok in a throwaway temp `--cwd` with planning/subagents/web-search off and
  mutating tools denied (Chronicle reference), so a reply can't explore/edit this repo.
- **grok-terminal IMAGE rebuilt** (`src/image/grokTerminal.ts`). Grok Build never prints PNG
  bytes on stdout; `/imagine <prompt>` writes a file under
  `~/.grok/sessions/<enc(cwd)>/<sessionId>/images/` and records its path in
  `chat_history.jsonl`. The default runner drives `/imagine` in a temp dir, locates the file
  (chat-history `path`, then a newest-image salvage scan), reads the bytes, and cleans up both
  the temp cwd and grok's session copy (so a cron cycle doesn't grow `~/.grok` unbounded).
  Exported `findGrokImagePath` / `newestImageUnder` are unit-tested against a fake tree.
- The provider/runner INTERFACES are unchanged (`TerminalTextRunner` → `{stdout,code}`,
  `TerminalImageRunner` → `{bytes,code}`), so all injected-runner tests still hold; the new
  protocol lives in the default runners + the small text-envelope unwrap.
- Tests **266 passing** (+10). Gates clean: `process.env` only in `secrets.ts`; no lego.
- **LIVE KEYLESS PROOF:** ran the real `npm run cycle -- --no-deploy` against a bounded 2-item
  local feed with `generator`/`image` = grok-terminal and local storage, `XAI_API_KEY` unset
  and no API keys present → `generate: 2 generated, 0 pending`, `image: 2 stored, 0 failed`,
  `render: 2 publishable → 10 files`, exit 0. Both stored files are valid 1280×720 images from
  the grok subscription CLI; headlines are original rewrites; categories assigned. Zero
  API-key warnings.
- **Follow-up (not this cycle):** grok emits JPEG, but the storage layer names artifacts
  `<id>.png` / content-type `image/png` (`src/image.ts` + `src/storage/*`). Browsers
  content-sniff so images render, but the extension/Content-Type are cosmetically wrong for a
  real Blob store — worth a small follow-up to derive the type from the bytes.
- **Box action:** the box `config.json` still has the pre-grok-terminal `generator.provider`
  (`"subscription"` → aliases to `claude`) and no `image` block. To run fully keyless, set
  BOTH `generator.provider` and `image.provider` to `"grok-terminal"` (or delete the blocks so
  they default there now). `config.example.json` is the current correct shape.

---

## Archival note

The reverse-chronological log above is the live record; newest cycles are prepended at the top.

An earlier, Slice-7/8-era block that used to live below this point — the original
`## Current state`, `## Next up`, and `## Open questions / blocked / known limitations`
sections plus the one-time box prerequisites and crontab template — was **removed on
2026-07-14** during a documentation audit. It described "Slice 8" as the final slice with an
open PR and listed already-shipped work (ApiKeyGenerator, imagegen integration, render, age-out)
as future work, directly contradicting the current top-of-file state. The box setup / crontab /
prerequisite content it held is maintained in **[docs/INSTALL.md](docs/INSTALL.md)**; the full
prior text remains in git history if needed.
