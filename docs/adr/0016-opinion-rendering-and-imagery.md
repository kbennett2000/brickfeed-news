# ADR-0016: Opinion rendering + imagery

## Status

Accepted

## Context

ADR-0015's generation stage writes opinion pieces daily, but they are invisible: the
records carry no `wrappedPrompt`, so the image stage never heroes them, and
`isPublishable` (which requires `imageUrl` AND `caption`) keeps them out of
`published.json`. This ADR records how a piece becomes visible: how its hero prompt and
caption are derived, where the opinions stage sits in the cycle so a piece heroes the
same day it is written, and how the Opinion section renders — cards, piece pages, and
the disclosure surfaces ADR-0013/0014 specified as copy contracts.

One fact shapes everything here: the render's conditional-section machinery
(ADR-0013 d.9) means an opinion record that becomes publishable flows onto EVERY surface
automatically — homepage cover included — so the placement rules below are not optional
polish; they are what keeps satire off the news surface.

## Decision

1. **The hero prompt and caption are derived at opinion-generation time, as ONE extra
   single-purpose JSON completion per successful piece.** After a piece passes its
   length check, the stage asks the same `TextGenerator` seam for strict JSON
   `{"imagePrompt","caption"}`: the imagePrompt in the site's standard neutral-scene
   contract (short, purely visual, no text/logos/brands, a real photographed scene —
   never pre-stylized; `wrapBrickStyle` adds the brick styling downstream, exactly as
   for stories), its subject drawn from the piece's topic — the reacted-to news story
   for `news` personas, the invented letter's situation for `letters` personas — never
   the author or the act of writing. The caption is one short photo-caption line under
   the same rules. Deriving the caption here is deliberate: `isPublishable` requires
   `caption`, so this makes opinion records publishable with zero changes to
   `publish.ts`, and it gives the hero figure's figcaption real copy. It also flips
   `isGenerated` true for opinion records; `generateAll`'s author-exemption (ADR-0015)
   stays as belt-and-braces.

2. **Image-brief derivation failure fails that author — no record is stored.** The
   invariant is *stored opinion record ⇒ has `wrappedPrompt` + `caption`*: the image
   stage picks opinion records up purely by `wrappedPrompt` presence (zero
   special-casing), and no half-visible piece can exist. Because the idempotency key is
   only consumed by a stored record, the next cycle run that day retries the author —
   regenerating the piece text, a bounded and accepted cost.

3. **No backfill for pre-existing image-less records.** The eight `opinion-*-2026-07-13`
   records are burn-in artifacts from the ADR-0015 launch; they are purged at this
   cycle's launch through the store's own removal path (manifest drop +
   `storage.delete`, a safe no-op with no blob; count logged) and the launch batch is
   re-run fresh with `--authors all`.

4. **Placement fiat (reversible): opinion pieces render ONLY in the Opinion section.**
   They appear in the nav, on `opinion.html`, in the sitemap, and on their own
   `s/<id>.html` piece pages — never on the homepage (lead/rail/fill/brickyard) or any
   news-section surface. The sitemap KEEPS opinion URLs (the pieces are public content;
   only their placement is constrained). The operator-only, noindex `share.html`
   includes opinion rows unchanged — it is an unindexed worksheet, and excluding them
   would be special-casing for no reader-facing gain. Non-OPINION section pages already
   isolate by category, so the only new exclusion is the homepage cover filter.

5. **The cycle stage order becomes ingest → generate → opinions → image → ageout →
   render → deploy.** The opinions stage moves INTO the pipeline array, between
   `generate` and `image`, so a piece written at 06:00 heroes and publishes in the same
   cycle (the image stage's existing `writePublished` picks it up). Its `run()` is
   internally tolerant — every failure collapses to a `skipped — …` summary, never a
   throw — preserving ADR-0015's rule that an opinion problem can never break the news
   cycle inside an abort-on-throw pipeline. Dry-run output mirrors the new order and
   remains derivation-only (no provider calls from the cycle dry-run; gate verdicts stay
   `npm run opinions -- --dry-run`'s job).

6. **The four disclosure surfaces are hand-written versioned constants, enforced by
   hermetic render tests as a merge gate:**
   - The Opinion page banner, verbatim (ADR-0013 d.6): "The opinions expressed on this
     page are nothing more than the collective hallucinations of a delusional AI trying
     to read human news."
   - Every piece page footers the author's `byline_blurb` verbatim from front-matter.
   - Letters pieces ADDITIONALLY footer the letters constant — a single versioned
     export whose copy is owned by ADR-0014 d.6: "Reader letters are as fictional as
     the columnists. Linda does not exist. No one is writing to Tom."
   - Piece pages' og/twitter description = "Unhinged rantings of a delusional bot named
     {display_name}" + " — " + the piece excerpt, prefix FIRST so truncation can never
     remove it (ADR-0013 d.6). `opinion.html` itself carries a static meta description
     identifying the page as AI-generated satire — the only section page with a meta
     description, so every other page stays byte-identical.

7. **Presentation reuses the story card and landing-page templates (ADR-0013 d.8) with
   additive deltas.** Cards on `opinion.html` replace the desk byline with a byline row:
   avatar thumbnail (resolved from `data/headshots.json` via the author directory) +
   `display_name`, plus `column_title` for letters personas. A missing headshot entry or
   missing persona file degrades gracefully — no avatar / `record.author` as the display
   name — with a warning through an injected render logger; it never breaks the build.
   The piece page is the landing page's local branch (inline body, no outbound CTA);
   the body is model plain text rendered by escaping + blank-line paragraphization —
   never through the markdown pipeline, which is reserved for trusted operator input.
   Cards and share meta use a new pure word-boundary excerpt helper; the record's
   `description` keeps holding the full body (ADR-0015 d.5).

8. **`runOpinions` gains `config` as its first parameter** — the house stage convention
   (`ingest`, `generateAll`, `generateImages`, `ageOut` all take it) — to reach
   `brickStyle.styleLanguage` for the wrap. No new config keys, no cron changes, and no
   changes to persona bodies or the selection/gate logic.

## Consequences

- Opinion pieces become fully publishable records: they ride `writePublished`,
  `verifiedPublishableRecords` (the blob HEAD check works on their hero URLs unchanged),
  the sitemap, and the Opinion section appears in nav/footer automatically at first
  publish (ADR-0013 d.9) — while the cover filter keeps them off the homepage.
- The opinions stage now runs before the image stage, so its records' fresh `firstSeen`
  puts them at the front of the image stage's newest-first ordering — a launch batch
  heroes ahead of backlogged news stories within the same `maxStoriesPerCycle` budget.
- A same-day retry after a brief-derivation failure produces a different piece text
  (the piece is not stored, so nothing pins it). Accepted: pieces are disposable until
  stored, and storing a promptless piece would resurrect the invisible-record bug this
  cycle purges.
- Persona assets are read twice per full cycle (opinions stage + render author
  directory). Two cheap disk reads; each stage stays self-contained and independently
  tolerant.
- The excerpt length (240 chars) and avatar display size are presentation constants in
  the render, not config — changing them is a code change, like the copy constants.
- Changing any disclosure wording remains an ADR-level decision (ADR-0013); the render
  tests pin the exact strings, so a drive-by edit fails the suite.

## Alternatives considered

- **Extending the piece completion to also emit the image brief** (one call instead of
  two). Rejected: it couples the piece's output contract (title line + body) to a JSON
  envelope, making every piece parse-fragile to save one cheap Haiku call; a malformed
  brief would also take the piece down with it.
- **Backfilling briefs onto the existing image-less records.** Rejected: a second code
  path (store-then-patch) for exactly eight disposable burn-in records; the purge +
  re-run is simpler and exercises the real pipeline end to end.
- **Excluding opinion pieces from the sitemap.** Rejected: the pieces are public,
  linkable content with proper disclosure; hiding them from crawlers while serving them
  publicly buys nothing. The exclusion that matters is the homepage cover.
- **A placeholder caption ("Opinion") instead of a derived one.** Rejected: it would
  pass `isPublishable` but put filler copy under every hero; the caption comes from the
  same completion that already writes the scene, at no extra call.
- **Keeping opinions after ageout and accepting a one-cycle hero lag.** Rejected: the
  task prefers same-cycle visibility, and the reorder is a small, test-pinned move —
  the lag bought nothing except stage-list stability.
