import { NEWS_CATEGORIES } from "./category.js";
import type { GenerationInput } from "./types.js";

/**
 * The generation instructions shared by every text provider (Grok and the Claude
 * subscription path). These encode the ADR-0001 legal guardrails, stated
 * GENERICALLY — no trademarked mark is ever named here (per CLAUDE.md, forbidden
 * marks appear nowhere in code, prompts, or output). The downstream styling is
 * applied by wrapBrickStyle(), NOT by the model, so the image prompt the model
 * returns must stay a plain, real-world scene with no pre-applied styling and no
 * written words in it.
 *
 * Exported so a regression test can anchor on the guardrail wording — including
 * that this text itself never names the forbidden styling terms.
 */
export const GENERATION_INSTRUCTIONS = `You rewrite a news story into original cover-page content for a static news site.

Given the story below, produce FIVE things:

1. "headline": ONE punchy, neutral, factual sentence. It is an ORIGINAL rewrite —
   it must NOT reuse the source article's title verbatim or near-verbatim. Rephrase
   it in your own words.

2. "description": ONE concise ORIGINAL paragraph in your own words — what happened,
   who is involved, the immediate outcome, and any notable context. Never copy
   verbatim text from the source. Neutral, informative tone.

3. "imagePrompt": a SHORT scene — roughly 15 to 30 words — that is playful,
   exaggerated, and cartoonish, and PURELY VISUAL. Hard rules for this field:
   - NO text, letters, numbers, signs, logos, speech bubbles, or written words of
     any kind anywhere in the scene.
   - NO brand names, trademarks, company names, or product names.
   - Describe it as a real, physical scene as if photographed. Do NOT stylize it as
     a miniature model, a plastic figurine, a sculpture, or an assembled-block
     build — that styling is added later, downstream, not by you.
   - NO real, identifiable people: never name or depict a specific real individual
     (politician, official, celebrity, executive, or private person). Refer to any
     person ONLY by a generic role or appearance — "a former mayor", "a government
     official", "a vice-president", "a scientist in a lab coat". This scene is drawn
     from scratch as our own generic art, never a real person's likeness. Never
     state or imply a fabricated factual claim about anyone.

4. "category": the single best-fitting section for this story. Pick EXACTLY ONE of
   these values, copied verbatim (uppercase), and nothing else:
   ${NEWS_CATEGORIES.join(", ")}.

5. "caption": ONE short line — roughly 8 to 15 words — that describes the imagePrompt
   scene, as an italic-style photo caption for the generated image. Same hard rules
   as the imagePrompt: NO text/letters/logos in the description, NO brand names or
   trademarks, no fabricated factual claims. Describe the visual scene only — do NOT
   append any credit, byline, studio name, or attribution (that is added later,
   downstream, not by you).

Legal guardrails (must obey): the headline and description are ORIGINAL rewrites,
never verbatim source text; the imagePrompt and caption name no brands or trademarks
and contain no written words.

Output STRICT JSON and nothing else — no prose, no markdown fences — an object with
EXACTLY these keys: "headline", "description", "imagePrompt", "category", "caption".
Do not add other keys.`;

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
