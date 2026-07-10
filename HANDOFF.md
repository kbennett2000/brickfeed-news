# Handoff

## Current state
Slice 1 (RSS ingestion + story identity + manifest dedup) is built and on branch
`slice-1-rss-ingestion` with an open PR (see issue #1). The ingestion backbone works
end to end:
- `src/config.ts` — file-based config (`config.json`, git-ignored; `config.example.json` committed). No env vars.
- `src/rss.ts` — `fetchFeed` / `parseFeed` (fast-xml-parser). Per-item `<source>` → `sourceName`. Tolerant: bad items skipped, bad feeds → `[]`.
- `src/resolve.ts` — `resolveUrl`: HTTP-follow redirect resolution with a hard defensive fallback to the wrapped link.
- `src/id.ts` — `normalizeUrl` (lowercase host, strip whole query + fragment, strip trailing slash) + `storyId` (sha256).
- `src/manifest.ts` — atomic read/write of the text-only JSON manifest; missing/corrupt → empty.
- `src/ingest.ts` — orchestrator: fetch → resolve → id → dedup NEW vs KNOWN. Pure (manifest injected); `src/index.ts` is the CLI wrapper.
- Tests: 33 passing (vitest, all HTTP mocked). `grep -rn process.env src/` is clean.

Live-verified against `https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en`:
run 1 → 38 new; run 2 → 0 new / 38 known (lastSeen bumped, firstSeen preserved).

## Next up
- Slice 2 per the ADR: Claude generation layer (headline + description + image
  prompt) behind one `Generator` interface, imagegen call stubbed.

## Open questions / blocked / known limitations
- **Redirect resolution is effectively a no-op against today's Google News.** GN now
  serves a JS interstitial instead of an HTTP 3xx, so `response.url` == the wrapped
  link and every story falls back to hashing the wrapped `CBM…` link. Dedup/identity
  are still stable (the token is deterministic per article; query params are stripped
  before hashing), which is why run 2 reports 0 new. If cross-source dedup on the
  *real* destination is later wanted, implement GN URL decoding (base64 `CBM…` →
  batchexecute) in `src/resolve.ts` — deliberately deferred as out of scope here.
