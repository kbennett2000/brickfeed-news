# Locally hosted articles

brickfeed can publish **original, on-site articles** alongside the rewritten feed stories.
Unlike a feed story (which links out to a publisher), a locally hosted article's full text
lives on brickfeed itself. See [ADR-0010](adr/0010-local-hosted-articles.md) for the design.

## Authoring one

Drop a paired image + markdown file into `assets/articles/`, named by a shared basename:

```
assets/articles/article-01.jpg    # the article's toy-brick image
assets/articles/article-01.md     # metadata + body
```

Both halves are required — an article with no image is skipped (the same "never publish
without an image" rule the feed follows). Accepted image extensions: **`.png`, `.jpg`,
`.jpeg`, `.webp`**. Images are uploaded to storage and referenced by URL; they are never
committed to git (`assets/` is git-ignored).

## The `.md` format

```
Headline: Testing 1-2-3!

Byline: A test to end all tests until the next test, probably

Description: A brief shakedown of the local-article pipeline, from headline to hosted page.

Section: Technology

Main Page Rank: 2

SubPage Rank: 1

Expires: 07.15.2026

Body:
This is a test. For more information please visit [brickfeed.news](https://brickfeed.news)
```

| Field            | Required | Meaning |
|------------------|----------|---------|
| `Headline`       | **yes**  | The article headline. A file with no headline is skipped. |
| `Byline`         | no       | Shown verbatim (not the decorative "By the … Desk"). |
| `Description`    | no       | Short teaser shown on cards. Blank if omitted. |
| `Section`        | no       | One of the site sections (World, Politics, Business, Technology, Science, Sports, Culture, Opinion). Unknown/empty → World. |
| `Main Page Rank` | no       | Position on the **cover**. `1` = first story, `2` = second, … A rank past the story count lands last. `0` (default) = unranked. |
| `SubPage Rank`   | no       | Position on the article's **section page**, same rules as Main Page Rank. Also accepts the spelling `Sub Page Rank`. |
| `Expires`        | no       | Take-down date, `MM.DD.YYYY`. The article shows through the end of that day, then disappears everywhere. Omit (or use an invalid date) for no expiry. |
| `Body`           | no       | Everything after the `Body:` line is the article body, in **markdown**. Rendered on the article's own hosted page. |

Field keys are case-insensitive and tolerate extra spaces. Blank lines between fields are fine.

## What happens at render

- The article appears on the cover at its **Main Page Rank** and on its section page at its
  **SubPage Rank**. Rank `0` articles are placed at a position that shifts from cycle to cycle.
- Clicking the article (from the cover or a section) opens its hosted page at
  `s/<basename>.html` — e.g. `article-01.md` → `https://www.brickfeed.news/s/article-01.html`.
  That page renders the **Body** markdown; there is no outbound "read at source" link.
- The article is added to the private X share sheet (`share.html`) like any other story.
- Once past its `Expires` day, the article is dropped from every page automatically.

## Markdown

Bodies are rendered with [`marked`](https://marked.js.org/) (GitHub-flavored, soft line
breaks). Use a full URL in links (`[text](https://…)`) so they resolve off-site. Bodies are
trusted operator content and are **not** sanitized — don't paste untrusted HTML into one.

---

For a simple sponsor/link **banner** (not a story), use a banner ad instead — see
[ADS.md](ADS.md).
