# ADR-0011: Text generation moves to Claude (Haiku); Grok kept for images only

## Status
Accepted

## Context

ADR-0007 made the keyless `grok-terminal` provider the effective production default for
**both** text and image generation — one agentic `grok` CLI, one subscription login, no API
key at run time. That is still the right call for images. For text, the operator wants to move
to the Claude subscription CLI (`claude -p`) with **Haiku** as the default model: it produces
the five artifacts (`headline`, `description`, `imagePrompt`, `category`, `caption`) at quality
comparable to Grok, and consolidates the text path onto the same tooling used across the
operator's other apps.

The seams were already independent (`generator.provider` vs `image.provider`, separate
factories), and the `claude` provider (`SubscriptionGenerator`) already shares the exact prompt
builder (`src/prompt.ts`) and output parser (`src/generator/parse.ts`) with every other text
provider — so the move is configuration, not new code.

One real blocker was found and fixed first (PR #44): the `claude` runner spawned
`claude -p --bare …`, and `--bare` (minimal mode) skips loading the stored subscription login,
so headless generation returned "Not logged in" → null for every story. Dropping `--bare` fixed
it; a live check (`npm run check:claude`) then produced all artifacts 5/5 on Haiku.

## Decision

1. **Text generation runs on the `claude` provider with `claude-haiku-4-5-20251001`.**
   Production `config.json` sets `generator.provider: "claude"`,
   `generator.model: "claude-haiku-4-5-20251001"`. `config.example.json` matches so a fresh
   setup follows the same choice. Auth is the Claude CLI's stored subscription login (or
   `CLAUDE_CODE_OAUTH_TOKEN`); the provider preflight only warns, never blocks.

2. **Grok is used for images only.** `image.provider` stays `grok-terminal` (the keyless
   `grok` CLI `/imagine` path, ADR-0007). Grok is no longer in the text path for this
   deployment.

3. **No code-default change.** The code default when `generator.provider` is omitted remains
   `grok-terminal` (ADR-0007) — the switch is an explicit config choice, not a change to the
   library's fallback. The `claude` and `grok-terminal` text paths remain fully swappable.

## Consequences

- Text and image now run on two different subscription CLIs (`claude` and `grok`). Each fails
  safe independently: a null text result leaves the story pending; a failed image leaves the
  story unpublished until its image lands (unchanged pipeline invariants).
- Text generation now depends on the Claude CLI being logged in on the box. `npm run check:claude`
  is the pre-switch smoke test.
- Images still depend on the Grok subscription having credit. An out-of-credit Grok sub means
  image generation fails and stories sit unpublished — text (Claude) is unaffected.
- The legal guardrails are unchanged: original rewrites, our own generated art only, generic
  brick styling, no trademarks in prompts or output.

## Alternatives considered

- **Keep everything on `grok-terminal` (ADR-0007 status quo).** Rejected: the operator wants the
  text path on Claude/Haiku alongside their other apps.
- **Move images to Claude too.** Out of scope and unsupported — the image seam has no `claude`
  option by design; image generation stays on Grok.
- **Change the code default to `claude`.** Rejected: keeps ADR-0007's keyless default intact for
  anyone who omits the block; production selects `claude` explicitly instead.
