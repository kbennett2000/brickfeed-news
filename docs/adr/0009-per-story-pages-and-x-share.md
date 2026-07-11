# ADR-0009: Per-story landing pages + assisted-manual X share sheet

## Status
Accepted

## Context

When a brickfeed story is shared on X (Twitter), the URL that gets pasted is the
**outbound source article** — every story links straight out to the publisher (ADR-0005 /
`templates.ts`). So X fetches the *publisher's* Open Graph tags and renders *their* card:
brickfeed's own generated toy-brick image never appears in the share preview. There is no
brickfeed-owned URL per story for a card to point at, and no low-friction way to post a
story to X at all.

Two gaps, one slice:

1. **No shareable brickfeed URL per story.** A social card needs a page we control whose
   `og:image` is our art and whose `og:url` is itself.
2. **No posting affordance.** Posting is fully manual today. We want a $0, no-API,
   no-scheduling way to fire off a well-formed post.

This is a render-only slice: it lives entirely inside the pure render core
(`src/render/*`: records + clock in → `path → contents` out, no fs, no wall-clock) and the
two thin writers that persist its output. No ingestion/generation/image/storage changes.

## Decision

1. **Per-story landing pages at `site/s/<id>.html`, in the pure core.** For each
   publishable record `renderSite` emits a standalone page keyed by the story id (a sha256,
   filesystem-safe). Its `<head>` carries the social card: `twitter:card=summary_large_image`,
   `og:type=article`, `og:title`=headline, `og:description`=description,
   `og:image`+`twitter:image`=the record's already-absolute Blob `imageUrl`, and
   `og:url`=the page's own absolute URL. `twitter:site` is emitted **only** when a handle is
   configured. Every interpolated value is escaped (`escapeAttr`). The `<body>` shows the
   brick image, kicker, headline, dek, caption + `/ BRICKFEED STUDIO`, and a **prominent
   outbound link** to the source `url` (`target="_blank" rel="noopener noreferrer"`) — the
   card draws the reader in with our art, the page sends them to the source.

2. **New required config `render.siteBaseUrl`** (absolute origin, no trailing slash, e.g.
   `https://www.brickfeed.news`), validated at load. It is the only way to build the
   **absolute** `og:url` and the absolute landing URLs the share links point at — relative
   URLs are not valid for OG/Twitter cards. It defaults to the production origin when
   omitted so existing configs keep loading.

3. **Landing pages are self-contained, not full newspaper chrome.** They live in a `s/`
   subdirectory, so root-relative links in the masthead/nav/footer (`world.html`,
   `styles.css`) would break. A landing page therefore uses a lightweight brand header
   (wordmark → `../index.html`) and references the stylesheet as `../styles.css` via a new
   `assetPrefix` hook on `pageShell`. It reuses the existing `figure`, kicker, dek, and
   figcaption styles so it looks native.

4. **Assisted-manual share sheet at `site/share.html`.** One row per publishable story —
   image thumb + headline + a **"Post to X"** button whose `href` is the X Web Intent URL
   (`https://x.com/intent/tweet`) built with `URLSearchParams` (correct encoding): `text`=
   headline, `url`=the story's absolute landing-page URL, plus `hashtags` and `via` **only
   when configured**. A human opens `share.html` and clicks — X's composer opens prefilled.
   No API key, no OAuth, no scheduler, $0. The text is length-budgeted under 280 (reserving
   ~23 for the t.co-wrapped URL + the rendered hashtags); the headline is truncated with `…`
   if needed.

5. **New optional config `render.share { handle?, hashtags? }`.** `handle` is stored
   without a leading `@` (fed to `via=` and, as `@handle`, to `twitter:site`); `hashtags`
   is an array of bare tags (no `#`). Both absent by default — with none set, the intent URL
   carries only `text`+`url` and no `twitter:site` is emitted.

6. **The share sheet is private-by-intent: `<meta name="robots" content="noindex">` and
   NOT linked from the site nav or footer.** It is a build-time operator tool, not public
   content — it must not be indexed or discoverable from the paper.

7. **Two writers gain per-file subdirectory creation.** Because `s/<id>.html` keys contain
   a slash, `defaultCycleIo.writeSite` (`cycle.ts`) and the `render-cli.ts` write loop now
   `mkdir` each file's parent dir before writing. Otherwise unchanged.

## Consequences

- A shared brickfeed landing URL renders a `summary_large_image` card with our own art,
  then one tap sends the reader to the source — the publisher's card no longer stands in
  for ours.
- Posting to X is one click from a private, unindexed build page — no credentials, no cost.
- `render.siteBaseUrl` must be set correctly on the box (it defaults to the prod origin);
  a wrong value yields wrong `og:url`/share URLs but never breaks the render.
- Output grows by one landing page per publishable record plus one `share.html`; all remain
  gitignored `site/` build artifacts (the repo stays text-only) and are covered by the
  existing `grep -rin lego` gate over the render source and by the render tests.
- Legal surface unchanged: only our generated art (or a placeholder) is shown, every story
  still links to its source, the wordmark is always "brickfeed".
- Refines ADR-0005 (render architecture) additively; supersedes nothing.
