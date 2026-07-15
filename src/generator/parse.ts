import { normalizeCategory } from "../category.js";
import { looksLikeRefusal } from "../sanitize.js";
import type { GeneratorOutput } from "../types.js";

/** A real headline is one line; well above that is a leaked paragraph, not a headline. */
const MAX_HEADLINE_CHARS = 300;

/**
 * The defensive inner-JSON parser shared by every text Generator (subscription
 * Claude CLI and Grok HTTP). A chat model wraps its JSON in ```json fences, leading
 * or trailing prose, and stray whitespace; this module tolerates all of that and
 * normalizes to a GeneratorOutput, or returns null so the caller leaves the story
 * pending. It NEVER throws.
 */

/**
 * Parse arbitrary model text into a normalized GeneratorOutput. Extracts the
 * outermost {...} block first, then JSON.parses it. Returns null on any failure or
 * if a required non-empty string key is missing.
 */
export function parseGeneratorOutput(text: string): GeneratorOutput | null {
  // A refusal that happens to carry a stray {...} would otherwise slip through the
  // brace-slice below; reject it up front so a refusal is never published.
  if (looksLikeRefusal(text)) return null;

  const jsonSlice = extractJsonObject(text);
  if (jsonSlice == null) return null;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonSlice);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const headline = cleanString(obj.headline);
  const description = cleanString(obj.description);
  const imagePrompt = cleanString(obj.imagePrompt);
  const caption = cleanString(obj.caption);
  // caption is required like the other text fields — missing/empty leaves the story
  // pending. category is NOT: a bad value normalizes to WORLD so generation succeeds.
  if (!headline || !description || !imagePrompt || !caption) return null;
  // A "headline" the length of a paragraph is leaked prose, not a headline.
  if (headline.length > MAX_HEADLINE_CHARS) return null;
  const category = normalizeCategory(obj.category);

  return { headline, description, imagePrompt, category, caption };
}

/** Non-empty trimmed string, or "" if the value isn't a usable string. */
function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Extract the outermost JSON object from arbitrary text: strip code fences, then
 * take the substring from the first "{" to the last "}". Good enough for the
 * fenced / prose-wrapped / whitespace variants a chat model emits.
 */
export function extractJsonObject(text: string): string | null {
  // Drop the ```json ... ``` fence wrapper if present.
  const defenced = text.replace(/```(?:json)?/gi, "");
  const start = defenced.indexOf("{");
  const end = defenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return defenced.slice(start, end + 1);
}
