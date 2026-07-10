import type { GenerationInput } from "./types.js";

/**
 * The generation instructions handed to Claude. These encode the ADR-0001 legal
 * guardrails, stated GENERICALLY — no trademarked brand is ever named here (per
 * CLAUDE.md, forbidden marks appear nowhere in code, prompts, or output). The
 * toy-brick styling is applied downstream by wrapBrickStyle(), NOT by Claude, so
 * the image prompt Claude returns must stay a neutral, real-world scene.
 *
 * Exported so a regression test can anchor on the guardrail wording.
 */
export const GENERATION_INSTRUCTIONS = `You rewrite a news story into original cover-page content for a static news site.

Given the story below, produce THREE things:

1. "headline": an ORIGINAL, rewritten headline. It must NOT reuse the source
   article's title verbatim or near-verbatim — rephrase it in your own words.
   Keep it punchy and factual, at most ~12 words.

2. "description": one or two ORIGINAL sentences summarizing the story in your own
   words. Never copy verbatim text from the source. Neutral, informative tone.

3. "imagePrompt": a vivid but NEUTRAL description of a single real-world scene that
   evokes the story, suitable for an image generator. Hard rules for this field:
   - NO brand names, trademarks, logos, company names, or real people's names.
   - NO toy, brick, plastic-figure, miniature, diorama, or construction-set
     language of any kind. Describe a realistic scene as if photographed.
   - Describe setting, subjects, action, lighting, and mood. One or two sentences.

Legal guardrails (must obey): the headline and description are ORIGINAL rewrites,
never verbatim source text; the imagePrompt names no brands or trademarks.

Output STRICT JSON and nothing else — no prose, no markdown fences — an object with
EXACTLY these keys: "headline", "description", "imagePrompt". Do not add other keys.`;

/**
 * Build the full single-shot prompt for one story: the fixed instructions plus the
 * story context. Pure — no I/O, deterministic for a given input.
 */
export function buildGenerationPrompt(input: GenerationInput): string {
  const source = input.sourceName ? input.sourceName : "unknown source";
  return `${GENERATION_INSTRUCTIONS}

Story:
- Source article title: ${input.title}
- Publisher: ${source}
- Source URL: ${input.url}`;
}
