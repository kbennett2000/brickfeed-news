# ADR-0012: Vercel Pro improvements + per-story social share

## Status
Accepted

## Context

The site now runs on the Vercel **Pro** plan, and an audit of the live deployment found several
levers left on the table:

- **No `vercel.json` at all** — no CDN cache/security headers, no image config; all defaults.
- Story/ad/article images (~210 on the cover) were served straight from Vercel Blob at 1280 px
  WebP (ADR after last cycle) but **displayed ~300 px wide** — ~16× the pixels a grid card needs.
- **Lazy-loading was effectively defeated**: each story rendered a `loading="lazy"` thumbnail
  *and* a non-lazy full-size hover-zoom `<img>` at the same URL, so the browser eagerly fetched
  every image regardless. Banner ad images were eager too.
- **Web Analytics on, Speed Insights off** (the latter is a Pro RUM feature). No `robots.txt`,
  no `sitemap.xml`.

Separately, the operator wanted a public **X/LinkedIn share link under each story**, in the same
format the operator-only Share page already uses.

Key constraint: `site/` is git-ignored and rebuilt by `renderSite()` every render, then deployed
as-is (`vercel --prod --yes`, cwd `site/`). So **any deploy-root file — `vercel.json`,
`robots.txt`, `sitemap.xml` — must be emitted by the render**, not committed to the repo.

## Decision

1. **Responsive Image Optimization (Pro).** When `render.imageOptimization.enabled` (default) and
   the Blob host resolves, each story `<img>` gets a `srcset`/`sizes` of same-origin
   `/_vercel/image?url=…&w=…&q=…` variants (AVIF/WebP), and the render emits a `vercel.json` whose
   `images` block allow-lists the Blob host and declares the exact `sizes`/`qualities` requested.
   The raw Blob URL stays as the `<img src>` fallback; **build-time WebP downscaling is retained**
   as the source, so optimization degrades safely if disabled. Metered on Vercel — a conservative
   width ladder (`[320,480,640,960,1280]`) + `q75` + a long `minimumCacheTTL` keep transformations
   within the Pro allotment. `og:image`/`twitter:image` keep the absolute Blob URL (scrapers can't
   use a relative `/_vercel/image` path).

2. **Lazy-loading fix (free).** The hover-zoom and ad images are now `loading="lazy"
   decoding="async"`, restoring real deferral across all cover images.

3. **Speed Insights (Pro).** A plain-HTML Speed Insights beacon is injected alongside Web
   Analytics whenever `render.analytics: "vercel"`. Like the analytics beacon it 404s harmlessly
   until enabled in the dashboard, so shipping it early is safe. No new config surface.

4. **SEO + security (free/automatable).** The render emits `robots.txt` (allow all, disallow the
   noindex Share sheet, point at the sitemap) and `sitemap.xml` (cover + about + sections + every
   `s/<id>.html` landing page; Share sheet excluded). `vercel.json` always carries
   `X-Content-Type-Options: nosniff`, a conservative `Referrer-Policy`, and a `Cache-Control` for
   the un-hashed `styles.css`.

5. **Per-story share links.** `card()`/`leadStory()`/`railStory()` render an X + LinkedIn button
   below the story, reusing `buildXIntentUrl`/`buildLinkedInIntentUrl` (the exact Share-page
   builders) pointed at the story's absolute landing URL. Because the whole card is already an
   `<a>`, the share row is a **sibling** of that anchor inside a `.story` wrapper — never nested
   (invalid HTML + the card link would swallow the click). Emitted only for publishable stories
   (have a landing URL + image); imageless placeholders stay byte-identical.

6. **Firewall / bot filtering — manual dashboard steps.** Vercel WAF rules / Attack Challenge
   Mode / bot filtering are dashboard/API settings, not `vercel.json`, so they are **not**
   automated here. Operator action: enable Bot Filtering (and Attack Challenge Mode if abused)
   under the project Firewall, and enable Speed Insights + confirm Web Analytics.

## Consequences

- `render.imageOptimization` is on by default and provider-agnostic; a `local` storage provider
  (relative base URL) yields no Blob host, so optimization auto-skips and the render falls back to
  plain `<img>` (safe for local preview, which can't reach `/_vercel/image` anyway).
- Image Optimization is **metered**. Watch Vercel's usage; the conservative widths/quality/TTL are
  chosen to stay within the Pro included allotment for ~200 live images at hobby traffic.
- Existing render fixtures stay green because optimization is off in the test config and share
  rows are additive; the only intentional test updates were the config defaults and the
  analytics-beacon ordering (Speed Insights now sits last before `</body>`).
