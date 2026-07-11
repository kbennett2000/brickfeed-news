# Banner ads

brickfeed renders a small rotating **leaderboard banner** above the news on every page. Ads are
operator-managed: you drop image + link files into a folder and they publish on the next cycle —
no code, no ADR, no config. This doc is the contract (the behavior lives in
[../src/ads.ts](../src/ads.ts)).

## Authoring one

Drop a paired image + markdown file into `assets/ads/`, named by a shared basename:

```
assets/ads/ad-01.jpg    # the ad creative (our own art — never a publisher's image)
assets/ads/ad-01.md     # a single click-through URL
```

Both halves are required. An `.md` whose image hasn't landed yet (or vice-versa) is silently
skipped — the same "never publish without an image" rule the stories follow. Accepted image
extensions: **`.png`, `.jpg`, `.jpeg`, `.webp`**. The whole `assets/` tree is git-ignored;
images are uploaded to storage and referenced by URL, never committed.

## The `.md` format

The ad `.md` is intentionally trivial — a **single click-through URL**:

```
https://github.com/kbennett2000/slopify
```

- The first non-empty, trimmed line is used as the outbound link.
- It **must** start with `http://` or `https://`, or the ad is dropped (and logged).
- Anything after the first line is ignored.

## What happens at render

- Each valid ad's image is uploaded to storage under the key `ads/<basename>`
  (overwrite-in-place, so re-running a cycle republishes edits).
- Ads are drawn in ascending basename order as a banner (`aside.adbanner`) below the nav on
  **every** page. With more than one ad, the stylesheet crossfades between them.
- Each slide links to its click-through URL, opening in a new tab with
  `rel="noopener sponsored nofollow"` (marking it a paid/creator link).
- Alt text is auto-derived from the link host, e.g. `Advertisement — github.com`.

## Notes

- Ads are **not** stories: they carry no headline/section/rank and never appear in the manifest,
  section pages, per-story `s/<id>.html` pages, or the X share sheet.
- To remove an ad, delete its file pair; it disappears on the next cycle. (The stored image is
  not actively deleted — like the About portrait, ad images live outside the manifest, so
  age-out never touches them.)
- For on-site *stories* (with a headline, section, rank, and a hosted body page), use a locally
  hosted article instead — see [ARTICLES.md](ARTICLES.md).
