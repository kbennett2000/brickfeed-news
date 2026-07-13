/**
 * The static site's chrome CSS (Slice 7), authored from the exact design tokens in
 * design_handoff_brickfeed/README.md and re-expressed as semantic classes (the prototype
 * was all inline styles + a proprietary DSL — reference only, not copied verbatim).
 *
 * This is committed SOURCE chrome, not a generated news image, so it lives in the repo
 * (per the slice brief). `renderSite` writes it out verbatim as `styles.css`. It contains
 * no trademarked brand name anywhere — the wordmark is always "brickfeed".
 *
 * Hard-edged broadsheet aesthetic: no border-radius (except the 1px studs), no shadows.
 * `--accent` (brick red) and `--rule-color` (column rules) are themeable custom properties
 * with literal fallbacks so first paint is correct.
 */
export const STYLES = `:root {
  --paper: #f6f2ea;
  --paper-alt: #efe9dd;
  --ink: #211d18;
  --ink-80: #3f3a32;
  --ink-70: #4a453c;
  --ink-60: #5a5248;
  --muted: #6b6154;
  --faint: #93897a;
  --fainter: #a1978a;
  --credit: #b3a795;
  --hairline: #ddd5c7;
  --hairline-alt: #d8d0c1;
  --motto-rule: #c7bdac;
  --accent: #c1372c;
  --rule-color: #ddd5c7;
  --photo-field: #e9e3d8;
  --photo-border: #cbc2b2;
  --photo-stud: #cbb7a3;
  --photo-label: #a79c8b;
  --mono: ui-monospace, Menlo, monospace;
  --serif: 'Newsreader', Georgia, serif;
  --display: 'Bodoni Moda', serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
a:hover { color: var(--accent); }
img { max-width: 100%; display: block; }
::selection { background: rgba(193, 55, 44, 0.18); }

.container { max-width: 1280px; margin: 0 auto; padding: 0 40px; }

/* ---- studs glyph (brand mark) ---- */
.studs { display: inline-grid; grid-template-columns: repeat(2, var(--s, 5px)); grid-auto-rows: var(--s, 5px); gap: 2px; flex: none; }
.studs--6 { --s: 6px; }
.studs--7 { --s: 7px; }
.studs--9 { --s: 9px; gap: 3px; }
.studs--10 { --s: 10px; gap: 3px; }
.studs__cell { border-radius: 1px; background: var(--ink); }
.studs__cell:nth-child(1), .studs__cell:nth-child(4) { background: var(--accent); }
.studs--photo .studs__cell,
.studs--photo .studs__cell:nth-child(1),
.studs--photo .studs__cell:nth-child(4) { background: var(--photo-stud); }

/* ---- utility strip ---- */
.utility { border-bottom: 1px solid var(--hairline); }
.utility__inner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 40px;
  font: 500 11px/1 var(--mono);
  letter-spacing: 0.13em; text-transform: uppercase; color: var(--muted);
}
.utility__date { flex: 1; }
.utility__edition { flex: 1; text-align: center; color: var(--fainter); }
.utility__spacer { flex: 1; }

/* ---- masthead ---- */
.masthead { padding: 44px 40px 30px; text-align: center; }
.masthead__nameplate {
  margin: 0; font-family: var(--display); font-weight: 600;
  font-size: clamp(60px, 11vw, 142px); line-height: 0.86; letter-spacing: -0.015em;
  text-transform: lowercase;
}
.masthead__motto-row { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 20px; }
.masthead__rule { height: 1px; width: 70px; background: var(--motto-rule); }
.masthead__motto { font: 500 12px/1 var(--mono); letter-spacing: 0.32em; text-transform: uppercase; color: var(--muted); }

/* ---- sticky section nav ---- */
.nav { position: sticky; top: 0; z-index: 20; background: var(--paper); border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); }
.nav__inner { display: flex; align-items: stretch; justify-content: space-between; height: 54px; gap: 20px; }
.nav__brand { display: flex; align-items: center; gap: 9px; font-family: var(--display); font-weight: 600; font-size: 22px; text-transform: lowercase; }
.nav__links { display: flex; align-items: stretch; gap: 20px; flex-wrap: wrap; }
.nav__link { position: relative; display: flex; align-items: center; font: 600 12px/1 var(--serif); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink); transition: color .15s ease; }
.nav__link--active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px; background: var(--accent); }

/* ---- shared story bits ---- */
.kicker { font: 600 11px/1 var(--serif); letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent); }
.kicker--sm { font-size: 10px; }
.byline { font: 500 10px/1 var(--mono); letter-spacing: 0.09em; text-transform: uppercase; color: var(--faint); }
.byline--lead { font-size: 11px; }
.dek { font-family: var(--serif); line-height: 1.5; color: var(--ink-60); }

/* ---- figure / photo ---- */
.figure { margin: 0; }
.figure__frame {
  position: relative; overflow: hidden;
  background-color: var(--photo-field);
  border: 1px solid var(--photo-border);
}
.figure__frame--lead, .figure__frame--rail, .figure__frame--seclead { aspect-ratio: 3 / 2; }
.figure__frame--card { aspect-ratio: 4 / 3; }
.figure__img { width: 100%; height: 100%; object-fit: cover; }
.figure__placeholder {
  position: absolute; inset: 0;
  background-image: repeating-linear-gradient(45deg, rgba(33,29,24,0.045) 0 2px, transparent 2px 12px);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  color: var(--photo-label);
}
.figure__label { font: 500 10px/1 var(--mono); letter-spacing: 0.22em; text-transform: uppercase; }
.figcaption { font-family: var(--serif); font-style: italic; font-size: 13px; color: var(--faint); margin-top: 9px; }
.figcaption__credit { font-style: normal; text-transform: uppercase; letter-spacing: 0.1em; font-size: 10px; color: var(--credit); }

/* ---- image zoom-on-hover (CSS-only full-size preview) ---- */
/* The frame crops via object-fit:cover; dwelling on it for ~1s reveals the whole image at
   natural size, centered over a flat scrim (no shadow, per the aesthetic), fading in and out.
   pointer-events:none so it never blocks the story link or other cards. Hidden on touch. */
.figure__zoom {
  position: fixed; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  padding: 4vmin;
  background: rgba(33, 29, 24, 0.55);
  opacity: 0; visibility: hidden; pointer-events: none;
  /* Leaving: fade out promptly (no delay), then flip hidden once fully faded. */
  transition: opacity .3s ease, visibility 0s linear .3s;
}
.figure__zoom-img {
  max-width: 90vw; max-height: 90vh; width: auto; height: auto;
  border: 1px solid var(--photo-border);
}
@media (hover: hover) {
  /* Entering: hover-intent — hold 1s, then reveal and fade in. Moving away before 1s shows
     nothing (opacity is still 0 through the delay, so the leave transition is a no-op). */
  .figure__frame:hover + .figure__zoom {
    opacity: 1; visibility: visible;
    transition: opacity .3s ease 1s, visibility 0s linear 1s;
  }
}

/* ---- hero ---- */
/* Two columns: the lead + a few pulled-up overflow cards (.hero__main) beside the taller rail.
   align-items:start keeps the shorter column top-aligned so any leftover space is a small trailing
   gap at its bottom, never a void under the lead. */
.hero { padding-top: 46px; display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 44px; align-items: start; }
.hero--solo { grid-template-columns: 1fr; }
.hero__main { min-width: 0; }
.hero__fill { margin-top: 40px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 34px 30px; }
.lead { min-width: 0; }
.lead__body { margin-top: 20px; }
.lead__headline { cursor: pointer; margin: 11px 0 0; font-family: var(--display); font-weight: 600; font-size: clamp(33px, 3.6vw, 52px); line-height: 1.01; letter-spacing: -0.012em; transition: color .15s ease; }
.lead .dek { font-size: 20px; color: var(--ink-80); margin: 17px 0 0; max-width: 62ch; }
.lead .byline { margin-top: 15px; }

.rail { min-width: 0; border-left: 1px solid var(--rule-color); padding-left: 44px; display: flex; flex-direction: column; gap: 30px; }
.rail__item { display: block; }
.rail__item .figure { margin-bottom: 13px; }
.rail__headline { margin: 8px 0 0; font-family: var(--display); font-weight: 600; font-size: 25px; line-height: 1.08; transition: color .15s ease; }
.rail .dek { font-size: 15px; margin: 9px 0 0; }
.rail .byline { margin-top: 11px; }

/* ---- card grid ("Across the Brickyard") ---- */
.brickyard { padding-top: 52px; }
.brickyard__head { display: flex; align-items: baseline; justify-content: space-between; border-top: 2px solid var(--ink); padding-top: 9px; margin-bottom: 26px; }
.brickyard__title { font: 600 13px/1 var(--serif); letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink); }
.brickyard__meta { font: 500 10px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--fainter); }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 34px; }
.cards--section { grid-template-columns: repeat(3, 1fr); gap: 36px; }
.card { display: flex; flex-direction: column; position: relative; transition: top .18s ease; }
.card:hover { top: -3px; }
.card__body { padding-top: 15px; }
.card__headline { margin: 8px 0 0; font-family: var(--display); font-weight: 600; font-size: 22px; line-height: 1.12; transition: color .15s ease; }
.card__body .dek { font-size: 15px; margin: 9px 0 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cards--section .card__body .dek { -webkit-line-clamp: 3; }
.card__body .byline { margin-top: 12px; }

/* Per-story share row (ADR-0012): sits BELOW a card/lead/rail item, as a sibling of the story's
   own link (never nested inside it). The .story element wraps the link + this row so they stack. */
.story { display: flex; flex-direction: column; }
.story-share { display: flex; align-items: center; gap: 7px; margin-top: 10px; }
.story-share__label { font: 500 10px/1 var(--mono); letter-spacing: 0.13em; text-transform: uppercase; color: var(--muted); }
.story-share__btn { display: inline-block; padding: 4px 11px; background: var(--ink); color: var(--paper); font: 500 10px/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; transition: background .15s ease, color .15s ease; }
.story-share__btn:hover { background: var(--accent); color: var(--paper); }
.story-share__btn--linkedin { background: #0a66c2; }
.story-share__btn--linkedin:hover { background: #004182; }

/* ---- section page head ---- */
.section-head { padding-top: 48px; }
.section-head__row { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-top: 8px; }
.section-head__title { margin: 0; font-family: var(--display); font-weight: 600; font-size: clamp(44px, 6vw, 84px); line-height: 0.9; letter-spacing: -0.015em; }
.section-head__aside { text-align: right; padding-bottom: 6px; }
.section-head__blurb { font-family: var(--serif); font-style: italic; font-size: 17px; color: var(--muted); max-width: 34ch; }
.section-head__meta { font: 500 10px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--fainter); margin-top: 8px; }
.section-grid { padding-top: 38px; }

/* ---- about page ---- */
.about { padding-top: 42px; display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 48px; align-items: start; padding-bottom: 10px; }
.about__portrait { margin: 0; }
.about__frame { background-color: var(--photo-field); border: 1px solid var(--photo-border); }
.about__img { width: 100%; height: auto; }
.about__lead { font-family: var(--serif); font-size: 21px; line-height: 1.5; color: var(--ink-80); margin: 0; max-width: 60ch; }
.about__links { display: flex; flex-wrap: wrap; gap: 12px 28px; margin-top: 30px; }
.about__link { font: 600 12px/1 var(--serif); letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); border-bottom: 1px solid var(--accent); padding-bottom: 4px; transition: color .15s ease, border-color .15s ease; }
.about__link:hover { color: var(--ink); border-color: var(--ink); }

/* ---- empty state ---- */
.empty { padding: 90px 40px; text-align: center; }
.empty__title { font-family: var(--display); font-weight: 600; font-style: italic; font-size: 30px; color: var(--ink); margin: 0; }
.empty__note { font-family: var(--serif); font-size: 17px; color: var(--muted); margin-top: 12px; }

/* ---- footer ---- */
.footer { border-top: 2px solid var(--ink); margin-top: 70px; }
.footer__inner { padding: 48px 40px 56px; }
.footer__brandwrap { text-align: center; padding-bottom: 38px; border-bottom: 1px solid var(--hairline); }
.footer__brand { display: inline-flex; align-items: center; gap: 11px; }
.footer__wordmark { font-family: var(--display); font-weight: 600; font-size: 34px; text-transform: lowercase; }
.footer__motto { font: 500 11px/1 var(--mono); letter-spacing: 0.28em; text-transform: uppercase; color: var(--fainter); margin-top: 14px; }
.footer__cols { display: flex; gap: 72px; padding: 34px 0; }
.footer__col-title { font: 600 11px/1 var(--serif); letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink); margin-bottom: 14px; }
.footer__link { display: block; font-family: var(--serif); font-size: 15px; color: var(--ink-60); padding: 5px 0; }
.footer__disclaimer { border-top: 1px solid var(--hairline); padding-top: 22px; font-family: var(--serif); font-size: 13px; line-height: 1.55; color: var(--faint); max-width: 80ch; }
.footer__copy { display: block; margin-top: 8px; font: 500 10px/1 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--credit); }

/* ---- banner ad (leaderboard, below the nav) ---- */
/* All slides share one fixed frame box (needed so the crossfade can stack them absolutely).
   object-fit: contain scales EACH ad to fit whole — never cropped or stretched — so ads of
   any dimensions sit cleanly, letterboxed against the flat photo field. Rotation is driven
   by the inline rotator script (ADR-0017): it adds .is-live to the frame and walks a
   shuffled queue, toggling .is-active; the opacity transition below is the crossfade.
   Until/unless it runs (no JS, reduced motion, a single ad), the :not(.is-live) rule shows
   the first ad statically. pointer-events tracks visibility so only the shown ad is
   clickable. */
.adbanner { width: 100%; max-width: 970px; margin: 34px auto 0; }
.adbanner__label { font: 500 10px/1 var(--mono); letter-spacing: 0.22em; text-transform: uppercase; color: var(--credit); text-align: center; margin-bottom: 10px; }
.adbanner__frame { position: relative; aspect-ratio: 16 / 5; background-color: var(--photo-field); border: 1px solid var(--photo-border); overflow: hidden; }
.adbanner__slide { position: absolute; inset: 0; display: flex; opacity: 0; pointer-events: none; transition: opacity 0.9s ease; }
.adbanner__frame:not(.is-live) .adbanner__slide:first-child { opacity: 1; pointer-events: auto; }
.adbanner__slide.is-active { opacity: 1; pointer-events: auto; }
.adbanner__img { width: 100%; height: 100%; object-fit: contain; }
@media (prefers-reduced-motion: reduce) {
  .adbanner__slide { transition: none; }
}

/* ---- responsive ---- */
@media (max-width: 900px) {
  .container { padding: 0 24px; }
  .utility__inner, .masthead, .footer__inner { padding-left: 24px; padding-right: 24px; }
  .hero { grid-template-columns: 1fr; gap: 34px; }
  /* On narrow screens give the ad clear air below it so it doesn't crowd the lead image. */
  .adbanner { margin-top: 26px; margin-bottom: 26px; }
  .rail { border-left: 0; padding-left: 0; border-top: 1px solid var(--rule-color); padding-top: 30px; }
  .cards { grid-template-columns: repeat(2, 1fr); }
  .cards--section { grid-template-columns: repeat(2, 1fr); }
  .section-head__row { flex-direction: column; align-items: flex-start; }
  .section-head__aside { text-align: left; }
  .about { grid-template-columns: 1fr; gap: 30px; }
  .about__portrait { max-width: 320px; }
}
@media (max-width: 560px) {
  .cards, .cards--section { grid-template-columns: 1fr; }
  .hero__fill { grid-template-columns: 1fr; }
  .footer__cols { flex-direction: column; gap: 34px; }
  .nav__inner { height: auto; flex-direction: column; align-items: flex-start; gap: 10px; padding-top: 10px; padding-bottom: 10px; }
  .nav__link { padding: 4px 0; }
}

/* ---- standalone pages: per-story landing (s/<id>.html) + share sheet (share.html) ---- */
.standalone__brand {
  border-bottom: 1px solid var(--hairline);
  padding: 16px 0;
  margin-bottom: 28px;
  background: var(--paper);
}
.standalone__wordmark {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 40px;
  font-family: var(--display);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ink);
  text-decoration: none;
}

.landing__main { max-width: 760px; padding-bottom: 60px; }
.landing__article { display: block; }
.landing__headline {
  font-family: var(--display);
  font-weight: 700;
  font-size: 40px;
  line-height: 1.06;
  letter-spacing: -0.015em;
  margin: 12px 0 14px;
  color: var(--ink);
}
.landing__dek { font-size: 19px; line-height: 1.5; }
.landing__cta {
  display: inline-block;
  margin-top: 28px;
  padding: 13px 22px;
  background: var(--accent);
  color: #fff;
  font-family: var(--mono);
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  text-decoration: none;
}
.landing__cta:hover { filter: brightness(0.92); }

/* Locally hosted article body (ADR-0010): rendered markdown under the landing headline. */
.landing__body { margin-top: 22px; font-family: var(--serif); font-size: 19px; line-height: 1.6; color: var(--ink); }
.landing__body > :first-child { margin-top: 0; }
.landing__body p { margin: 0 0 1.1em; }
.landing__body h2, .landing__body h3 { font-family: var(--display); font-weight: 600; line-height: 1.14; margin: 1.4em 0 0.5em; }
.landing__body h2 { font-size: 27px; }
.landing__body h3 { font-size: 22px; }
.landing__body a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.landing__body ul, .landing__body ol { margin: 0 0 1.1em; padding-left: 1.4em; }
.landing__body li { margin: 0.3em 0; }
.landing__body blockquote { margin: 1.2em 0; padding-left: 1em; border-left: 3px solid var(--hairline); color: var(--muted); font-style: italic; }
.landing__body img { max-width: 100%; height: auto; }

/* ---- Opinion section (ADR-0016): banner, signed byline row, piece disclosures ---- */
/* margin-bottom ONLY — the shorthand would clobber .container's "margin: 0 auto" centering
   (same specificity, later in the sheet), shoving the banner to the viewport's left edge. */
.opinion-banner { margin-bottom: 22px; }
.opinion-banner__text {
  font-family: var(--serif);
  font-style: italic;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ink-60);
  border-top: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
  padding: 12px 0;
  margin: 0;
}
.byline-opinion { display: flex; align-items: center; gap: 10px; }
.byline-opinion__avatar { width: 48px; height: 48px; object-fit: cover; flex: none; background: var(--photo-field); border: 1px solid var(--photo-border); }
.byline-opinion__name { color: var(--ink-60); }
/* Avatar + name link to the bio page (ADR-0019); inherits the row's look, underlines on hover. */
.byline-opinion__link { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
.byline-opinion__link:hover .byline-opinion__name { text-decoration: underline; color: var(--accent); }
/* Opinion card byline is a .story sibling of the card link (never nested in it, ADR-0019). */
.story > .byline-opinion { margin-top: 12px; }
.landing .byline-opinion { margin: 14px 0 18px; }
.landing__disclosure { margin-top: 28px; border-top: 1px solid var(--hairline); padding-top: 14px; }
.landing__blurb, .landing__letters {
  font-family: var(--serif);
  font-style: italic;
  font-size: 14px;
  line-height: 1.5;
  color: var(--faint);
  margin: 0 0 0.6em;
}

/* ---- Columnist bio pages + cast strip (ADR-0019) ---- */
.cast-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; margin-bottom: 22px; }
.cast-strip__member { display: flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.cast-strip__avatar { width: 48px; height: 48px; object-fit: cover; flex: none; background: var(--photo-field); border: 1px solid var(--photo-border); }
.cast-strip__name { font: 500 12px/1.2 var(--mono); letter-spacing: 0.04em; color: var(--ink-60); }
.cast-strip__member:hover .cast-strip__name { color: var(--accent); text-decoration: underline; }
.colbio__main { max-width: 820px; }
.colbio__head { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; margin: 10px 0 34px; }
.colbio__headshot { width: 256px; height: 256px; object-fit: cover; flex: none; background: var(--photo-field); border: 1px solid var(--photo-border); }
.colbio__ident { flex: 1 1 300px; }
.colbio__name { font-family: var(--display); font-weight: 700; font-size: 34px; line-height: 1.1; margin: 0 0 6px; }
.colbio__column { font-family: var(--serif); font-style: italic; font-size: 16px; color: var(--ink-60); margin: 0 0 14px; }
.colbio__bio { font-family: var(--serif); font-size: 16px; line-height: 1.6; margin: 0 0 0.8em; }
.colbio__archive-head { font: 500 12px/1 var(--mono); letter-spacing: 0.13em; text-transform: uppercase; color: var(--muted); border-top: 1px solid var(--hairline); padding-top: 14px; margin: 0 0 16px; }
.colbio__empty { font-family: var(--serif); font-style: italic; color: var(--faint); }

.sharesheet__main { max-width: 820px; padding-bottom: 60px; }
.sharesheet__title {
  font-family: var(--display);
  font-weight: 700;
  font-size: 34px;
  letter-spacing: -0.01em;
  margin: 0 0 6px;
  color: var(--ink);
}
.sharesheet__note { font-family: var(--serif); color: var(--muted); font-size: 15px; margin: 0 0 26px; }
.sharesheet__list { list-style: none; margin: 0; padding: 0; }
.sharesheet__row {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 16px 0;
  border-top: 1px solid var(--hairline);
}
.sharesheet__row:last-child { border-bottom: 1px solid var(--hairline); }
.sharesheet__thumbwrap { flex: 0 0 auto; }
.sharesheet__thumb {
  display: block;
  width: 96px;
  height: 64px;
  object-fit: cover;
  background: var(--photo-field);
  border: 1px solid var(--photo-border);
}
.sharesheet__thumb--empty { display: flex; align-items: center; justify-content: center; }
.sharesheet__body { flex: 1 1 auto; min-width: 0; }
.sharesheet__headline {
  font-family: var(--display);
  font-weight: 600;
  font-size: 19px;
  line-height: 1.2;
  margin: 4px 0 0;
  color: var(--ink);
}
.sharesheet__actions { flex: 0 0 auto; display: flex; gap: 8px; }
.sharesheet__post {
  flex: 0 0 auto;
  padding: 10px 18px;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  text-decoration: none;
  white-space: nowrap;
}
.sharesheet__post:hover { background: var(--accent); }
.sharesheet__post--linkedin { background: #0a66c2; }
.sharesheet__post--linkedin:hover { background: #004182; }
.sharesheet__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 22px;
}
.sharesheet__chip {
  padding: 6px 14px;
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--hairline);
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  cursor: pointer;
}
.sharesheet__chip:hover { color: var(--ink); border-color: var(--ink); }
.sharesheet__chip.is-active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.sharesheet__section { margin: 0 0 8px; }
.sharesheet__section-title {
  font-family: var(--mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin: 26px 0 2px;
}
.sharesheet__row[hidden], [data-section][hidden] { display: none; }
@media (max-width: 560px) {
  .landing__headline { font-size: 30px; }
  .sharesheet__row { flex-wrap: wrap; }
  .sharesheet__body { flex-basis: 60%; }
  .sharesheet__actions { flex-basis: 100%; }
}
`;

