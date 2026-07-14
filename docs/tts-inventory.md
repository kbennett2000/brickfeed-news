# TTS local-provider — Phase 1 inventory

Recorded facts from the exploration that preceded ADR-0021, so the follow-up cycle that
actually builds the provider starts from ground truth rather than re-exploring. TTS =
`text-transform-service`, a LAN LLM at `http://G434:8712` (qwen3.5:9b).

## Provider architecture (three independent seams)

All interfaces live in `src/types.ts`. Each seam has its own factory and its own config key;
they are selected and invoked separately.

| Seam | Interface | Selected by | Implementations |
|------|-----------|-------------|-----------------|
| Story text | `Generator.generate(GenerationInput) → GeneratorOutput \| null` (`src/types.ts:107`) | `generator.provider` | grok-terminal, claude, grok (xAI), apikey (stub, throws) |
| Free-form text | `TextGenerator = (prompt) => Promise<string \| null>` (`src/generator/text.ts:22`) | `generator.provider` (same key) | grok-terminal, claude, grok |
| Image (pixels) | `ImageProvider.generate(wrappedPrompt) → Uint8Array \| null` (`src/types.ts:180`) | `image.provider` | grok-terminal, grok (xAI), local |

Contract for all three: **never throw; return `null` on any failure.** A story is never
published without its image; a failed text call leaves the story pending.

- Text factory: `createGenerator` (`src/generator/index.ts:26`) and `createTextGenerator`
  (`src/generator/text.ts:37`), both switching on `config.generator.provider`.
- Image factory: `createImageProvider` (`src/image/index.ts:18`), switching on `config.image.provider`.
- Selection convention: a `*_PROVIDERS` const tuple + `DEFAULT_*` constants + a block validator
  (`validateGenerator`/`validateImage` in `src/config.ts`) + a factory `switch`.
- Env is read in exactly one module, `src/secrets.ts` (the hard `grep process.env src/` gate).
  Non-secret endpoints (e.g. `image.local.url`) live in `config.json`, not secrets.
- Cron: `scripts/cycle.sh` sources nvm + `cron.env` (`set -a; . cron.env; set +a`) so env vars
  reach `npm run cycle`.

Production runs `generator.provider: "claude"` (Haiku `claude-haiku-4-5-20251001`, ADR-0011);
images run on keyless `grok-terminal` (ADR-0007).

## Every task Claude handles today (4 distinct)

One bundled **story** call plus three **opinion** calls. Image *prompt text* is authored by
Claude (tasks 1 and 4); image *pixels* are Grok, never Claude. Brick styling is applied
downstream by `wrapBrickStyle`, not by the model.

| # | Task | Path | Call site | Prompt builder | Output shape |
|---|------|------|-----------|----------------|--------------|
| 1 | Story cover bundle | story | `src/generator/subscription.ts:43` via `src/generate.ts:97` | `buildGenerationPrompt` (`src/prompt.ts:62`) | JSON `{headline, description, imagePrompt, category, caption}` |
| 2 | Opinion topic-gate classifier | opinion | `src/opinions.ts:490` | `buildGatePrompt` (`src/opinions.ts:187`) | JSON `{verdicts:[{id, verdict, reason}]}` |
| 3 | Opinion piece | opinion | `src/opinions.ts:549` | `buildOpinionPrompt` (`src/opinions.ts:283`) | plain text: title line + blank + body |
| 4 | Opinion image brief | opinion | `src/opinions.ts:595` | `buildImageBriefPrompt` (`src/opinions.ts:358`) | JSON `{imagePrompt, caption}` |

Parsers / normalizers: `parseGeneratorOutput` (`src/generator/parse.ts`), `parseGateVerdicts`
(`src/opinions.ts:213`, fail-closed = all excluded), `splitTitleBody` (`src/opinions.ts:324`),
`parseImageBrief` (`src/opinions.ts:405`). Category enum: `CATEGORIES` (`src/category.ts:10`).

## Live TTS registry (as of 2026-07-13)

`curl http://G434:8712/v1/transforms` → five transforms:

| Transform | Options | Output schema | Notes |
|-----------|---------|---------------|-------|
| `cast-canonicalize` | `{name, aliases, descriptors, era, genre}` | `{visual_description, one_line, tags}` | belongs to another app (cast/ledger) |
| `cast-mentions` | `{}` | `{mentions:[{name, aliases, descriptors, is_person}]}` | another app |
| `illustration-prompt` | `{ledger, cast, era}` | `{prompt, depicted, shot, avoid}` | another app; requires ledger+cast |
| `scene-update` | `{prior_ledger, cast_names, era}` | `{location, time_of_day, atmosphere, present, …}` | another app |
| `image-prompt` | `{}` | `{prompt}` (string 30–400) | the only generic transform |

## Mapping table — Brickfeed task → TTS transform

Updated after the TTS repo shipped the requested transforms (cycles T9/T10) and the Brickfeed
provider was built (ADR-0022). The routing + failover contract is captured in ADR-0022.

| # | Brickfeed task | TTS transform | Status | On TTS error |
|---|----------------|---------------|--------|--------------|
| 1 | Story cover bundle (5 fields) | `story-cover` | **SHIPPED — routable** | failover → Claude |
| 2 | Opinion topic-gate classifier | `opinion-gate` | **SHIPPED — routable** | **fail-closed (exclude)** |
| 3 | Opinion piece (title+body) | — | **HELD** (out of TTS charter) | n/a — stays on Claude |
| 4 | Opinion image brief (imagePrompt+caption) | `opinion-image-brief` | **SHIPPED — routable** | failover → Claude |

**Key facts (ADR-0022).** Tasks 1, 2, and 4 route to TTS via the opt-in `generator.tts` block
(all flags default false → byte-identical to today). Task 3 (`opinion-piece`) is HELD by product
decision and stays on the incumbent Claude provider permanently. Every TTS image prompt is
subject-neutral — the toy-brick style is wrapped ONCE downstream (`wrapBrickStyle`), so the
provider returns prompts unwrapped. The gate fails **closed** on any TTS error (ADR-0022 decision
#3), not over to Claude. The now-superseded `image-prompt` GAP analysis (Brickfeed never issues a
standalone image-prompt call) is retained below for history.
