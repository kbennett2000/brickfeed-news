# ADR-0010: Locally hosted articles

## Status
Accepted

## Context

Every brickfeed story to date comes from the RSS feed and links **out** to a publisher (the
paper is a rewritten cover over other people's reporting). We want a second, complementary
kind of story: a **locally hosted article** whose full text lives ON brickfeed — original
copy the operator writes, hosted and read on the site itself, not a link to somewhere else.

The scaffolding to author these should feel exactly like the existing banner ads (ADR-0004 /
`src/ads.ts`): the operator drops a paired image + sidecar file into a git-ignored `assets/`
folder, and a tolerant loader uploads the image to storage and hands the render a view. Unlike
an ad (a bare click-through URL), an article is a real story: it must appear on the cover and
its section page at a chosen position, carry a headline/byline/teaser, come down on a date, and
have a hosted page that renders its body.

This is a render-stage feature, like ads: no ingestion, generation, image, or storage-model
changes. It reuses the per-story landing page from ADR-0009 (`s/<id>.html`) as the hosted
destination — that page already exists to carry a social card with our own art; for a local
article it simply renders the body inline instead of an outbound "read at source" link.

## Decision

1. **Articles are creator-managed file pairs under `assets/articles/`, loaded like ads.**
   `article-NN.jpg` + `article-NN.md`, paired by basename; both halves required (same "never
   publish without an image" rule). `src/articles.ts` mirrors `src/ads.ts`: tolerant,
   never-throw, IO boundaries injected, images uploaded to storage under an `articles/<base>`
   key and referenced by URL (the repo stays text-only — `assets/` is git-ignored).

2. **The `.md` is a small structured document**, parsed by a pure, unit-tested `parseArticle`:

   ```
   Headline: …            (required — a headline-less file is skipped)
   Byline: …
   Description: …         (optional teaser shown on cards)
   Section: Technology    (normalized to a CATEGORY; unknown → WORLD)
   Main Page Rank: 2      (cover placement; 0 = unranked)
   SubPage Rank: 1        (section-page placement; 0 = unranked)
   Expires: 07.15.2026    (MM.DD.YYYY; shows through the end of that day)
   Body:                  (everything after this line is the markdown body)
   …markdown…
   ```

   Keys are matched case-insensitively and whitespace-tolerantly, so both `SubPage Rank` and
   `Sub Page Rank` are accepted. Ranks default to 0 and clamp negatives/invalids to 0.

3. **Rank places the article in the ordered story list.** Rank 1 = first story on the page,
   2 = second, …; a rank beyond the story count clamps to last. Main Page Rank applies to the
   cover; SubPage Rank applies to the article's section page. **Rank 0 ("position doesn't
   matter") is inserted at a pseudo-random slot** derived from a stable hash of the article id
   + the current edition/date (`hashString` in `format.ts`) — so the slot varies across cycles
   yet is fully deterministic for a pinned clock, keeping the pure render hermetic and testable.
   Ranked articles are inserted after unranked ones so their 1-based positions hold on the
   final list.

4. **The hosted page reuses `s/<id>.html` (ADR-0009), with the body inline.** The article id is
   its basename (e.g. `article-01`), giving `s/article-01.html`. `renderLandingPage` gains a
   local branch: a `local` StoryView renders its `bodyHtml` (and no outbound CTA), while a feed
   story is unchanged (dek + "Read the full story at the source"). Cover/section links to a
   local article are **internal, same-tab** (no `target="_blank"`); feed links still open the
   source in a new tab. Local articles have no timestamp, so the "· N hr ago" byline tail is
   omitted. They also join the assisted-manual X share sheet.

5. **Expiry is applied in the pure render core against `now`, not in the loader.** An article
   past its Expires day is dropped from every page (cover, section, its own `s/` page); a
   missing/unparseable Expires never expires. The loader stays clock-free; the image upload of
   a soon-to-expire article is a negligible, overwrite-in-place cost.

6. **Markdown bodies are rendered with `marked` (`src/render/markdown.ts`).** This is a
   deliberate, recorded exception to the project's minimal-deps convention: the rest of the
   render is hand-built, escape-everything template literals, but an article Body is real
   markdown and a hand-rolled parser is not worth the risk. Bodies are authored by the site
   operator (trusted), so `marked`'s default raw-HTML pass-through is acceptable — we do not
   sanitize.

7. **No config block.** Like ads, articles are simply loaded from the conventional
   `ARTICLES_DIR = "assets/articles"`; both render paths (`cycle.ts` and `render-cli.ts`) call
   `loadArticles` alongside `loadAds`, and `CycleIo` gains a `loadArticles` boundary so tests
   stay hermetic.

## Consequences

- The operator can publish original, brickfeed-hosted stories by dropping two files into
  `assets/articles/`, choosing where each lands and when it comes down — no code, no feed.
- Output grows by one `s/<id>.html` page per live article; all remain git-ignored `site/`
  build artifacts and are covered by the render tests and the `grep -rin lego` gate.
- Legal surface unchanged: only our own generated art is shown, the wordmark is always
  "brickfeed", and article copy is the operator's own original writing.
- Adds one production dependency (`marked`); the minimal-deps ethos is otherwise preserved.
- Refines ADR-0009 (per-story pages) additively; supersedes nothing.
