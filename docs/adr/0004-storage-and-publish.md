# ADR-0004: Durable image storage, image-gated publish, and age-out

## Status
Accepted

## Context
ADR-0001 (#4 idempotent image-gated publishing, #5 images-never-in-git) and ADR-0003 (#5
"`out/` is a temporary Slice-3 sink") deferred durable storage to Slice 4. Slice 3 wrote
image bytes to a gitignored `out/<id>.png` purely for eyeballing: no durable URL, no
manifest write-back, and no idempotency (every `wrappedPrompt` record was re-rendered each
run). This slice — the last backend slice — makes images durable and the pipeline
idempotent, ending at a manifest that carries durable image URLs plus a derived
`published.json`. No page render, HTML, or UI is in scope.

## Decision

1. **One `StorageProvider` interface, two impls selected by config**, mirroring the
   Generator (ADR-0001 #6, Slice 2c) and ImageProvider (ADR-0003 #1) dual-provider pattern.
   `put(id, bytes, contentType) -> string | null`; `delete(id) -> void`. Default provider is
   **Vercel Blob** (`src/storage/blob.ts`); the **local directory** provider
   (`src/storage/local.ts`) is the switchable alternative for LAN/self-hosted serving
   (`storage.provider` = `"blob" | "local"`). Raw `fetch` / `node:fs`, no SDK, no new deps.

2. **Never-throw contract, matching the generation/image layers.** `put` returns `null` on
   ANY failure (missing token, transport error, non-2xx, write error) so the story stays
   unpublished and is retried next run — never half-published. `delete` swallows every
   failure (logged, non-fatal) so age-out can always drop the record.

3. **Deterministic, overwrite-safe key by story id.** Objects are keyed
   `{pathPrefix}{id}{ext}` (default `images/<id>.png`); Blob uploads set
   `x-add-random-suffix: 0` so re-storing a story overwrites in place. The orchestrator
   skips already-stored records, so re-storage never actually happens — but the key stays
   stable, which is what makes delete reconstructable.

4. **Durable URLs and delete targets are built from `storage.blob.publicBaseUrl`.** Vercel
   Blob's delete API needs the object's public URL, and `delete(id)` gets only an id. Rather
   than parse the (undocumented) store id out of the token, we add one config field — the
   store's public host — and form both the returned URL and the delete target
   deterministically as `{publicBaseUrl}/{pathPrefix}{id}{ext}`. This is symmetric with
   `storage.local.publicBaseUrl` and lets a later run/process delete an object it didn't
   upload. `publicBaseUrl` may be `""` until a store exists (config still loads); a real
   value is required for live Blob use.

5. **Idempotency via presence of `imageUrl`.** The image pass generates + stores only for
   records that have a `wrappedPrompt` and NO `imageUrl`. `imageUrl` + `imageStoredAt` are
   written together, all-or-nothing, only after a successful `put` — same presence-based,
   no-status-flag convention as Slice 1 dedup / Slice 2 generation. A record with an
   `imageUrl` is skipped entirely: never re-generated, never re-uploaded.

6. **Image-gated publishing is a pure predicate.** `isPublishable(record)` is true iff it
   has `headline` + `description` + `imageUrl`. `publishableRecords(manifest)` returns the
   publishable records newest-first by `firstSeen`. The backend's final output is the
   manifest plus a derived `published.json` (the newest-first list) — the seam the future
   render slice consumes. Nothing is rendered here.

7. **Age-out deletes real artifacts and drops the record regardless of delete outcome.**
   Records whose `lastSeen` is older than `config.maxAgeHours` are dropped from the manifest
   AND, if they have an `imageUrl`, their stored object is deleted for real (images live in
   storage, not git — a real delete, unlike the text-only manifest). The record is dropped
   **before** the delete is attempted and **regardless** of its result: we do NOT tombstone
   or retry. A rare orphaned blob is an accepted trade for simplicity; delete failures are
   logged and non-fatal.

8. **Secrets stay confined to `secrets.ts`.** `BLOB_READ_WRITE_TOKEN` is read only via the
   new `getBlobReadWriteToken()` getter (lazily, inside `put`/`delete`), keeping the
   `grep process.env src/` gate pointing at a single file. The token is never config.

## Consequences
- The image pass is now idempotent and resumable, matching the text layer: a failed image
  (provider or storage) leaves the story pending, never a half-published entry; re-runs
  re-pay for nothing already stored.
- `out/` is retired; `src/image-cli.ts` now stores durably and writes the manifest +
  `published.json`. A new `npm run ageout` (`src/ageout-cli.ts`) runs the age-out step.
- The repo stays text-only: manifest, `published.json`, and the local storage dir all live
  under the gitignored `data/`. Images are referenced by URL, never committed.
- Legal surface is unchanged: generic brick art only, our own generated images, no publisher
  images, no trademark terms anywhere.
- Trade-off accepted: age-out can orphan a blob if a delete fails (no tombstone). And the
  Blob provider needs `publicBaseUrl` configured for deletes/URLs — one extra config field
  beyond a bare token.
