# ADR-0013: Opinion section architecture

## Status
Accepted

## Context

The site's taxonomy has carried an `OPINION` section in `src/category.ts` since the taxonomy
became code (the 8-member `CATEGORIES` tuple), but the section has never had a content path:
the nav and footer hard-code `filter((c) => c !== "OPINION")`, and `opinion.html` renders as a
permanently empty page. The design for filling it is now complete: six fictional, **clearly
disclosed** AI persona authors write short opinion takes on recent articles already published
on the site. This ADR records the full architecture. The current cycle implements only the UI
groundwork — the Opinion section defined but hidden, and *all* sections rendered conditionally —
no personas, generation, headshot processing, config changes, or cron.

Because every persona is a bot writing opinions, disclosure is a hard requirement on par with
the existing legal guardrails: a reader must never be able to mistake an opinion piece for
human commentary, on the page or in a social-card preview.

## Decision

1. **Opinion pieces are produced by a new pipeline stage using the existing provider
   abstraction** — the `Generator` seam (`src/types.ts`), with `grok-terminal` as the default
   and the API providers as alternates — not by Claude Code skills. The stage slots into the
   existing cycle alongside story generation and shares its never-throw, null-on-failure
   contract.

2. **Six personas live as versioned prompt assets in `personas/*.md`.** The roster: Alice
   (progressive columnist), Bob (conservative columnist), Edgar (politically unpredictable
   nostalgic crank), Stryker (Gen Z, anti-gerontocracy), Larry (economist), Cynthia
   (culture/media critic). Each file's front-matter carries `name`, `display_name`,
   `byline_blurb`, and `selection_bias` (per-section weights steering which articles the
   persona reacts to). Headshots live by convention at `assets/headshots/{name}.png` — there is
   **no `avatar_seed` field**; a schema test asserts the file exists for every persona. A shared
   guardrail block in `personas/_shared.md` is prepended to every generation prompt.

3. **Cadence is stateless: two pieces per day from a fixed pair.** Pair order is
   `[alice+bob, edgar+stryker, larry+cynthia]`; the active pair is
   `daysSinceUnixEpoch (UTC) % 3`. No state file. A missed cron day is simply skipped — never
   backfilled.

4. **Idempotency keys off `opinion-{author}-{YYYY-MM-DD}` (UTC).** One publish key per author
   per day; a rerun on the same day regenerates nothing that already landed, matching the
   story pipeline's "never reprocess" invariant.

5. **Retention is section-specific.** Opinion pieces expire per config `opinionMaxAgeHours`,
   defaulting to **168** when absent — it **never** inherits the global `maxAgeHours`. The
   cleanup sweep must branch by section so opinion pieces and news stories age out on their own
   clocks.

6. **Disclosure is three static, hand-written, versioned copy surfaces — never
   model-generated:**
   - The Opinion page banner, verbatim: "The opinions expressed on this page are nothing more
     than the collective hallucinations of a delusional AI trying to read human news."
   - A per-piece footer: the author's `byline_blurb` from front-matter (e.g. Alice: "Alice is a
     bot struggling to make sense of a human world. She may be 1's and 0's, but deep down
     inside she's just as confused as the rest of us.").
   - The Twitter Card description prefix: "Unhinged rantings of a delusional bot named
     {display_name}" — always the **front** of the description so truncation cannot remove it.

7. **Selection and content guardrails.** Selection excludes tragedy/violence/victim-centered
   stories via a topic gate (mechanism specified in the generation cycle). Personas react only
   to what source articles report; they critique institutions, policies, and works — never
   private individuals; no medical/legal/financial advice; Larry cites numbers only if they are
   present in the source articles.

8. **Layout reuses the existing story card and article templates** with three deltas: a byline
   row (avatar thumbnail + display name) on cards and pieces, the `byline_blurb` as the piece
   footer, and the banner on the section page. Headshots run through the standard image
   optimization path (`src/image/optimize.ts` via the storage chokepoint,
   `src/storage/optimizing.ts`) as an idempotent build-time step (skipped when the source hash
   is unchanged), emitting a ~128px avatar variant.

9. **All section rendering becomes conditional — this cycle's implementation.** A section with
   zero published items in the current build (feed records plus live local articles) is omitted
   entirely: no nav link, no footer link, no emitted `<section>.html`, no sitemap entry. This
   replaces the two hard-coded `!== "OPINION"` filters with one data-driven rule, so Opinion
   appears automatically the day its first piece publishes, and any news section that empties
   out disappears the same way.

## Consequences

- Opinion stays invisible until the generation stage (a future cycle) publishes its first
  piece — no config flag needed to launch the section; content presence is the switch.
- Empty section URLs now 404 instead of serving an empty-state page. They are also dropped
  from the sitemap, so nothing links to them; an emptied section's page comes back as soon as
  it has content again.
- This supersedes the ADR-0005-era render behavior of emitting a page for every category and
  the "OPINION hidden in nav" special case. The About link becomes a permanent trailing nav
  entry rather than sitting "in Opinion's slot."
- Out of scope for this cycle (future cycles implement per this ADR): `personas/*.md` and the
  schema test, the generation stage + topic gate, headshot processing, `opinionMaxAgeHours`
  config, cadence/cron wiring, and the byline/banner/social-card template deltas.
- The disclosure surfaces are copy contracts: changing their wording is an ADR-level decision,
  not a prompt tweak.
- The legal guardrails are unchanged and extend to personas: original writing only, our own
  generated art (including headshots), generic brick styling, no trademarks.

## Alternatives considered

- **Generate opinions with Claude Code skills.** Rejected: the pipeline already has a pluggable
  `Generator` seam with a never-throw contract, config-selected providers, and tests; a second
  generation mechanism would duplicate all of it.
- **`avatar_seed` in front-matter with generated-on-demand avatars.** Rejected: a checked-in
  headshot per persona is simpler, deterministic, and reviewable; the schema test makes the
  convention enforceable.
- **A state file for cadence.** Rejected: `daysSinceUnixEpoch % 3` gives the same rotation with
  zero state to corrupt, and "skip, never backfill" makes missed days harmless.
- **Inheriting `maxAgeHours` for opinion retention.** Rejected: opinion pieces are two-a-day
  evergreen-ish takes; tying their lifetime to the news feed's 72h churn would empty the
  section most days.

## Amendment (2026-07-13)

Decision 8 said the headshot step emits "a ~128px avatar variant". The implemented step
(`src/headshots.ts`) emits ONE square avatar at **256×256** — twice the ~128 px display
size, so avatars stay sharp on retina/high-DPI screens — center-cropped via
`cropSquareAvatar` (lossless PNG intermediate), then WebP-q80-encoded by the same storage
optimization chokepoint story images use. The display size is still ~128 px; only the
stored pixel dimensions changed. Idempotency is a sha256 source-hash check against the
derived `data/headshots.json` manifest (`--force` reprocesses). See branch
`feat/opinion-headshots`.
