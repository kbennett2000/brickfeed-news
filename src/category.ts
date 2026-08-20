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
  "SPORTS",
  "CULTURE",
  "OPINION",
] as const;

/** One of the fixed section names. */
export type Category = (typeof CATEGORIES)[number];

/**
 * The categories a NEWS story may be assigned — every section EXCEPT `OPINION`. `OPINION` is
 * reserved for authored columnist pieces produced by the opinions stage (ADR-0033); a news
 * story must never carry it, or it leaks onto the opinion page as an authorless "Opinion Desk"
 * item that bypasses the taste gate. The news prompt offers only these; the news parse coerces
 * a stray `OPINION` back to the default.
 */
export const NEWS_CATEGORIES = CATEGORIES.filter((c) => c !== "OPINION") as readonly Category[];

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

/**
 * Normalize a NEWS story's category (ADR-0033): as `normalizeCategory`, but a valid `OPINION`
 * value is coerced to `DEFAULT_CATEGORY`. `OPINION` is reserved for authored columns — a news
 * story tagged OPINION (model error) would otherwise leak onto the opinion page. Never throws.
 */
export function normalizeNewsCategory(value: unknown): Category {
  const category = normalizeCategory(value);
  return category === "OPINION" ? DEFAULT_CATEGORY : category;
}
