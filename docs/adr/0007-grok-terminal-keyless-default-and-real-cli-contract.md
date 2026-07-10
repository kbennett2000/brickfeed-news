# ADR-0007: grok-terminal is the keyless default, against the real grok CLI contract

## Status
Accepted (corrects ADR-0006 #7)

## Context
ADR-0006 #7 introduced keyless `grok-terminal` providers for prod (subscription CLI, no API
key, for BOTH text and image) and explicitly flagged the CLI contract as "an assumption tuned
on the box during live-verify." Two things were wrong in practice:

1. **The keyless path was never the effective default.** `DEFAULT_PROVIDER` and
   `DEFAULT_IMAGE_PROVIDER` were `"grok"` — the xAI **API-key** paths. A fresh or legacy
   `config.json` (the box's predated the rename: `generator.provider "subscription"` → claude,
   no `image` block → grok) therefore demanded `XAI_API_KEY` and skipped every story. The
   documented prod topology (100% keyless) was not what `npm run cycle` actually did.

2. **The assumed CLI contract was false.** The real `grok` is an agentic *coding* CLI (like
   `claude -p`), not a bare text/image endpoint. Verified live on the box:
   - TEXT: it needs the prompt as the `-p <prompt>` **value** with `--output-format json`
     (not on stdin), and returns a `{ "text": "<reply>", "sessionId": ... }` envelope on
     stdout — the model reply is nested in `.text`.
   - IMAGE: it **never** prints image bytes on stdout. `/imagine <prompt>` writes the file to
     `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/images/` and records its absolute
     path in that session's `chat_history.jsonl` (a `tool_result` whose JSON `content` has a
     `path`).

   The prior implementation wrote the prompt on stdin with empty args (launching the
   interactive TUI) and expected raw PNG bytes on stdout. Both had only ever been mock-proven.

## Decision

1. **Keyless is the default.** `DEFAULT_PROVIDER` and `DEFAULT_IMAGE_PROVIDER` are
   `"grok-terminal"`; `config.example.json` matches. A fresh/legacy config resolves to the
   keyless subscription path and never requires `XAI_API_KEY`. The `XAI_API_KEY` advisory
   warning stays confined to the API-key `grok` branch, which is no longer the default.

2. **The default runners speak the real grok protocol**, mirroring the Chronicle reference
   (which cages this same CLI in production):
   - Shared headless flags: isolated `--cwd <tempdir>`, `-p <prompt>`, `--output-format json`,
     `--no-plan --no-subagents --disable-web-search`, and `--deny` on the mutating/shell tools
     (`Bash`, `Shell`, `Terminal`, `Edit`, `Write`). Isolation is the real safety boundary — a
     stray agentic reply cannot explore or edit this repo — and it also cuts latency.
   - TEXT: `extractGrokText` unwraps the `.text` envelope; the shared, defensive
     `parseGeneratorOutput` then handles fences/prose inside it.
   - IMAGE: run `/imagine <wrappedPrompt>`, locate the written file (the session
     `chat_history.jsonl` `path`, then a newest-image salvage scan keyed to the run start so a
     timeout-killed run still yields its image), read the bytes, and remove both the temp cwd
     and grok's own `~/.grok/sessions` copy for that run (bounded disk under a cron cycle).

3. **The injected boundaries are unchanged.** `TerminalTextRunner` still resolves
   `{stdout, code}` and `TerminalImageRunner` still resolves `{bytes, code}`, so the provider
   classes stay pure/never-throw and every hermetic injected-runner test still holds. The new
   protocol lives entirely in the default runners plus the small text-envelope unwrap
   (`extractGrokText`) and the two exported, unit-tested file-location helpers
   (`findGrokImagePath`, `newestImageUnder`).

## Consequences
- Prod runs keyless out of the box for both text and image, proven live: a real
  `npm run cycle -- --no-deploy` with no API keys generated and stored real images end to end.
- The grok session-layout read (image path from `chat_history.jsonl`, salvage under
  `~/.grok/sessions/.../images/`) is the one place a Grok Build internal-layout change would
  bite; it is isolated in `src/image/grokTerminal.ts` and covered by helper tests.
- `command`/`args` stay configurable (the binary and any extra flags are tuned on the box);
  the structural protocol flags are supplied by the runner, since they are required for
  correctness, not preference.
- The secrets gate holds: the runners use `os.homedir()`/`os.tmpdir()`, never `process.env`.
- Known cosmetic gap (follow-up, not this ADR): grok emits JPEG while the storage layer names
  artifacts `<id>.png` with content-type `image/png`. Images render (content sniffing) but the
  extension/Content-Type should be derived from the bytes for a real Blob store.
