/**
 * The fixed news-section taxonomy (Slice 6). One category is attached to every
 * generated story; it must mirror the render nav exactly, so it is a CODE CONSTANT
 * (single source of truth) rather than config — the pure prompt.ts and parse.ts
 * seams import it directly without needing a config injection.
 *
 * Uppercase, ordered to match the nav. Adding/removing a section is a deliberate
 * contract change here, not a config tweak.
 */
export const CATEGORIES = [
  "WORLD",
  "POLITICS",
  "BUSINESS",
  "TECHNOLOGY",
  "SCIENCE",
  "SPORT",
  "CULTURE",
  "OPINION",
] as const;

/** One of the fixed section names. */
export type Category = (typeof CATEGORIES)[number];

/**
 * The never-throw fallback. The model MUST pick one enum value, but a story is never
 * blocked by a bad category: an invalid/missing/miscased value normalizes to WORLD so
 * generation still succeeds. (caption, by contrast, is required — see parse.ts.)
 */
export const DEFAULT_CATEGORY: Category = "WORLD";

/**
 * Normalize arbitrary model output to a valid Category. Trims and upcases a string
 * before matching; anything not in the set (including non-strings, null, undefined,
 * empty) becomes DEFAULT_CATEGORY. Never throws.
 */
export function normalizeCategory(value: unknown): Category {
  if (typeof value === "string") {
    const up = value.trim().toUpperCase();
    if ((CATEGORIES as readonly string[]).includes(up)) {
      return up as Category;
    }
  }
  return DEFAULT_CATEGORY;
}
