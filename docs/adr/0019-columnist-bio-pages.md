# ADR-0019: Columnist bio pages

## Status

Accepted

## Context

Opinion bylines (ADR-0016, ADR-0017) show an avatar and display name that link nowhere.
The personas were designed with bios-as-disclosure in mind: a reader who clicks a
columnist should land on a page that says, plainly, who (what) this author is. There is
also no single place to see the whole cast — opinion.html shows only whichever authors
published recently.

This slice is render-only: static bio pages, byline links to them, and a cast strip on
the section page. Generation, selection, rotation, config, retention semantics, and
deploy are untouched.

## Decision

1. **One static bio page per persona at `columnist/<name>.html`.** The subdir mirrors
   the `s/<id>.html` convention. Every loaded persona gets a page on every render —
   bio pages are static content with no retention, so an empty archive renders a small
   "no recent columns" state rather than hiding the page (unlike the section page's
   empty-section rule, ADR-0013). Chrome is the landing-page pattern (`standaloneBrand`
   + `../` asset prefix), a deliberate divergence from about.html's full nav: bio pages
   are leaf pages reached from bylines, and the standalone shell avoids threading
   section lists, datelines, and ad banners into eight more pages.

2. **Bio copy is human-written only — never model-generated.** A new optional `bio`
   front-matter field on `personas/<name>.md`: an inline `bio: text` is one paragraph;
   a bare `bio:` line opening an indented block is one paragraph per indented line.
   Absent → the bio page falls back to the persona's `byline_blurb` (already
   human-written disclosure copy). Presence must be valid: an empty block or a
   re-declared `bio` is a parse defect, per the schema's strictness on known fields.

3. **Byline rows link avatar + display name to the bio page — as a sibling of the card
   anchor, never inside it.** `card()` wraps the whole card in an `<a>`; nesting a bio
   link inside would be invalid HTML (browsers re-parent it). Opinion cards therefore
   move the byline row out of the card anchor and render it as a sibling inside the
   existing `.story` wrapper — the exact pattern the share row already uses
   (`withShare`). The link is emitted only when the author resolved in the persona
   directory; an unknown author degrades to today's linkless row.

4. **A cast strip on opinion.html, under the banner.** One row (wrapping on small
   screens) of all loaded personas — avatar + name, each linking to the bio page —
   in alphabetical order (the `loadPersonas` sort). It uses its own `cast-strip__*`
   classes, never `byline-opinion__*`, so byline fallbacks stay independently testable.
   Opinion section page only; the homepage stays opinion-free except nav (ADR-0016).

5. **Bio pages carry og/twitter meta with `og:type="profile"`.** The description is
   `` `${opinionMetaPrefix(displayName)} — ${byline_blurb}` `` — the established
   "Unhinged rantings of a delusional bot named …" prefix convention, prefix first so
   platform truncation can never drop the disclosure. `og:image` is the persona's
   256×256 avatar URL from the headshot manifest (`data/headshots.json`); a missing
   entry omits the tag and logs a warning rather than failing the render.

6. **The 256px headshot is displayed at full size on the bio page.** The stored avatar
   is 256×256 (ADR-0017 sized it for 2× retina at 48px display); the bio page is where
   the asset finally earns its resolution, with presentational `width`/`height`
   attributes like the byline avatar.

7. **Retired personas' bio pages are deleted at write time.** The rendered files map
   cannot see a persona's removal (pages are keyed to the current roster), so both
   writers (render CLI and the cycle's site writer) list `site/columnist/` and remove
   files not in the current render — decision logic in a pure, tested helper
   (`staleColumnistPages`), mirroring the stale-section-page cleanup.

8. **The sitemap gains the columnist URLs**, one per loaded persona, alongside the
   section pages.

## Consequences

- Every avatar/name in a byline is now a click-through to disclosure; the cast strip
  makes the full roster visible even when only two authors published recently.
- Opinion card markup changes shape: the byline row is a sibling of the card anchor
  inside `.story` (it no longer lifts with the card hover — same as the share row).
- Byline rows and cards gain a relative-path prefix (`""` on root pages, `"../"` on
  `s/` and `columnist/` pages) so every link works over `file://` and any mount point.
- Adding a persona automatically adds its bio page, cast-strip entry, and sitemap URL;
  the optional `bio` field is a punch-up surface, not a requirement.
- `cardMeta` learns an `ogType` parameter (default `"article"`, so existing landing
  pages are byte-identical); bio pages pass `"profile"`.

## Alternatives considered

- **Bio link inside the card anchor.** Rejected: nested anchors are invalid HTML and
  browsers re-parent them, breaking the card layout and swallowing clicks — the same
  reason the share row lives outside the anchor.
- **Full-nav chrome (about.html pattern) on bio pages.** Rejected: needs the section
  list, dateline, edition, and banner threaded into eight more pages for no reader
  benefit on a leaf page; the standalone landing-page shell already exists for exactly
  this shape.
- **Model-generated bios.** Rejected outright: bios are disclosure copy; the personas'
  voice bodies are human-owned and their public description must be too.
- **`og:type="article"` on bio pages.** Rejected: they are author pages, not articles;
  `profile` is the correct Open Graph type and costs one defaulted parameter.
- **A `bio` field as a required part of the schema.** Rejected: `byline_blurb` is
  already good single-paragraph disclosure copy; making `bio` optional keeps the
  punch-up loop incremental.
