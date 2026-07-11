# ADR-0003: Image provider layer

## Status
Accepted — but the **default** image provider chosen here (Grok Imagine via the xAI API) was
later superseded by the keyless `grok-terminal` default in
[ADR-0007](0007-grok-terminal-keyless-default-and-real-cli-contract.md). The provider-seam
design below still stands; only the default selection changed.

## Context
ADR-0001 (#7/#8) framed image generation around a LAN imagegen microservice, with
Claude/Grok producing only text. Slice 3 implements the image stage. Two things have
shifted since ADR-0001: (a) the text generator already defaults to Grok Imagine's
sibling API (Slice 2c), which runs on a plain `XAI_API_KEY` instead of the interactive
`claude setup-token` login that blocks headless runs; and (b) xAI now offers a hosted
image model (Grok Imagine) reachable the same way. We want the default path to work in
a headless cycle with no GPU box attached, while keeping the LAN microservice as a
first-class alternative.

## Decision

1. **One `ImageProvider` interface, two impls selected by config.** `generate(wrappedPrompt)
   -> Uint8Array | null`. Default provider is **Grok Imagine (xAI)**; the **local imagegen
   microservice** is the switchable alternative (`image.provider` = `"grok" | "local"`).
   This mirrors the dual-provider Generator pattern (ADR-0001 #6, extended in Slice 2c).

2. **Never-throw contract.** Any failure — missing key, transport error, non-2xx, bad
   response shape, unreachable service — returns `null`. The caller skips that story and
   retries next run; a bad image never crashes the pipeline or half-publishes a story
   (consistent with ADR-0001 #4).

3. **`wrapBrickStyle` stays the single styling chokepoint.** Both impls receive the SAME
   `wrappedPrompt` and pass it through unchanged. Neither applies brick styling itself
   (the local path sends a base/no-LoRA style so styling isn't double-applied). This
   invariant is regression-tested.

4. **xAI image URLs are ephemeral — download in-call.** The Grok Imagine response carries
   a short-lived image URL. The provider downloads the bytes within the same `generate()`
   call and returns them; the xAI URL is never persisted or passed downstream.

5. **`out/` is a temporary Slice-3 sink.** This slice writes returned bytes to a gitignored
   `out/<id>.png` purely for human visual inspection. It is NOT the storage backend:
   Slice 4 replaces it with a StorageProvider (images referenced by URL, never in git —
   ADR-0001 #5) plus manifest image fields and image-gated publish.

## Consequences
- The default image path runs headless with only `XAI_API_KEY` — no GPU box required for
  development — while the LAN microservice remains available by flipping one config value.
- Because Slice 3 has no manifest "already has an image" field yet, every record with a
  `wrappedPrompt` is (re)rendered each run, capped by `--limit`. Slice 4's manifest fields
  make image generation idempotent, matching the text layer.
- Legal surface is unchanged: generic brick art only, our own generated images, no
  publisher images, no trademark terms anywhere.
