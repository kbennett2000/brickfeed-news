/**
 * Defensive sanitizers for raw LLM completions before they become user-visible
 * article fields. Chat models occasionally ignore the "no preamble" contract and leak
 * meta-narration ("I see the task: ...", "Here is your column:"), bare markdown
 * delimiters ("---"), whole-completion code fences, or an outright refusal. Left
 * unguarded, the opinion parser takes the leaked first line as the headline (the
 * Priscilla "Wisdom's Moat" bug) and a refusal could be published verbatim.
 *
 * Every helper here is a pure, dependency-free string function with a single design
 * rule: be CONSERVATIVE. A guard may recover the correct content or signal the caller
 * to fail closed (drop the piece), but it must NEVER substitute wrong content — so a
 * legitimate short title is structurally undroppable and a real sentence is never
 * mistaken for a refusal. Shared by the opinion parser (src/opinions.ts) and the news
 * JSON parser (src/generator/parse.ts).
 */

/** A real title is short. Generous headroom: a legit title never crosses these; a
 * leaked preamble sentence or a body paragraph always does. */
export const MAX_TITLE_CHARS = 120;
export const MAX_TITLE_WORDS = 20;

/** Bare horizontal-rule line the model sometimes emits before the real title. */
const DELIMITER_RE = /^([-*_=])\1{2,}$/;

/** A "Title:" / "Headline:" label line; group 2 is the remainder (the real title). */
const LABEL_RE = /^(title|headline)\s*[:\-–]\s*(.*)$/i;

/** Meta-narration openers a chat model leads with when it ignores the no-preamble rule. */
const PREAMBLE_OPENER_RE =
  /^(here('?s| is| are)\b|sure\b|certainly\b|of course\b|okay\b|ok\b|below is\b|i['’]ll\b|i will\b|i see the task\b|i understand\b|let me\b|as requested\b|got it\b|absolutely\b|happy to\b)/i;

/**
 * A production verb/noun a meta-narration line names ("I'll write the column", "here is my
 * response") — the tell that an opener line is the model describing that it will produce the
 * piece, not an actual title.
 */
const META_PRODUCTION_RE =
  /\b(writ(e|ing)|compos(e|ing)|draft(ing)?|craft(ing)?|creat(e|ing)|produc(e|ing)|generat(e|ing)|provid(e|ing)|answer|respond(ing)?|column|piece|essay|letter|response|article|post|story|task|request|prompt)\b/i;

/**
 * True for a full sentence (ends in . ! ?) that opens with a meta-narration token AND names a
 * production verb/noun — the model narrating that it will produce the piece, e.g. "I'll write one
 * reader-letter column for Priscilla now." Requiring terminal sentence punctuation is the key
 * discriminator that keeps real short titles: "I'll Be There", "Let Me Write You a Letter", and
 * "Okay Boomer" open with a stop word but do NOT end in a period, so they never trip this.
 */
export function looksLikeMetaNarration(line: string): boolean {
  const t = line.trim();
  return /[.!?]$/.test(t) && PREAMBLE_OPENER_RE.test(t) && META_PRODUCTION_RE.test(t);
}

/**
 * A refusal lead. Anchored at the start and specific enough that a bare title never
 * trips it: "I Can't Even" needs a refusal object it lacks, "I'm Sorry" needs a
 * following ", but I". Matching signals the caller to fail closed — never publish a
 * refusal as a headline or body.
 */
const REFUSAL_RE = new RegExp(
  "^\\s*(?:" +
    "as an?\\s+(?:ai|assistant|(?:large\\s+)?language model)\\b" +
    "|i(?:['’]m| am)\\s+(?:unable|not able)\\s+to\\b" +
    "|i(?:['’]m| am)\\s+sorry[,.]?\\s+(?:but\\s+)?i\\b" +
    "|i\\s+(?:can(?:['’]?t|not)|cannot|will not|won['’]?t)\\s+" +
      "(?:help|assist|provide|write|create|comply|generate|produce|continue|complete|do that|fulfil|fulfill)\\b" +
    "|i\\s+(?:do not|don['’]?t)\\s+feel\\s+comfortable\\b" +
    "|i\\s+must\\s+decline\\b" +
    "|unfortunately,?\\s+i\\s+(?:can(?:not|['’]?t)?|am\\s+unable|will\\s+not|won['’]?t)\\b" +
    ")",
  "i",
);

/** True when the text opens like a model refusal (see REFUSAL_RE). */
export function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text.trim());
}

/**
 * Strip a code fence that wraps the ENTIRE completion (``` ... ```), returning the
 * inner text. Only fires start-to-end, so an inline code span inside a body is left
 * alone. Opinion prose should never be fenced; a whole-completion fence is pure
 * dressing (the news path already de-fences via extractJsonObject).
 */
export function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : trimmed;
}

/**
 * Remove the markdown dressing a model adds to a title line: a leading heading marker
 * and a matched pair of wrapping emphasis/quotes. Mirrors the inline logic the opinion
 * parser historically applied; shared so the length check and the parser agree.
 */
export function stripTitleDressing(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^(\*{1,3}|_{1,3}|["'“”]+)(.*?)(\1|["'“”]+)$/u, "$2")
    .trim();
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** A line short enough to be a real title once its markdown dressing is stripped. */
function isPlausibleTitle(line: string): boolean {
  const t = stripTitleDressing(line);
  return t.length > 0 && t.length <= MAX_TITLE_CHARS && wordCount(t) <= MAX_TITLE_WORDS;
}

/**
 * A leading line safe to drop as leaked preamble: it opens with known meta-narration
 * AND either contains a colon ("I see the task:", "Here is your column:"), is implausibly
 * long for a title (the leaked task description), or reads as a meta-narration sentence
 * ("I'll write one reader-letter column for Priscilla now." — short, colon-less, but a full
 * sentence about producing the piece; see looksLikeMetaNarration). The opener requirement
 * protects legit short titles that happen to start with a stop word ("Okay Boomer" opens with
 * "okay" but has no colon, is title-length, and isn't a production sentence, so it is kept).
 * Even when this over-fires, recoverLeadingTitleRegion only strips if a valid title+body
 * remains — so a colon-bearing real title with no title after it (e.g. "Okay: A Memoir") is
 * preserved.
 */
function isDroppablePreamble(line: string): boolean {
  const t = line.trim();
  return (
    PREAMBLE_OPENER_RE.test(t) &&
    (t.includes(":") || !isPlausibleTitle(t) || looksLikeMetaNarration(t))
  );
}

/**
 * Recover the real title region from a completion whose leading lines are junk. Skips
 * blank lines, bare delimiters, label markers, and droppable preambles, then returns
 * the text from the first plausible title onward — but ONLY when doing so still yields
 * a valid short title plus a non-empty body. If nothing was junk, or the recovery
 * would not produce a valid title+body, the input is returned unchanged so the caller's
 * existing null-check fails closed rather than inventing a wrong title.
 */
export function recoverLeadingTitleRegion(text: string): string {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");

  let i = 0;
  let labelTitle: string | null = null;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    if (DELIMITER_RE.test(line)) {
      i++;
      continue;
    }
    const label = line.match(LABEL_RE);
    if (label) {
      const remainder = label[2].trim();
      if (remainder === "") {
        i++;
        continue; // "Title:" alone — drop the marker line
      }
      labelTitle = remainder; // "Title: X" — X is the real title
      break;
    }
    if (isDroppablePreamble(line)) {
      i++;
      continue;
    }
    break; // first plausible title candidate
  }

  // Nothing was dropped or rewritten → leave it to the caller's normal parse.
  if (i === 0 && labelTitle === null) return trimmed;
  if (i >= lines.length) return trimmed; // all junk, no title found

  const candidate = (labelTitle ?? lines[i]).trim();
  const rest = lines.slice(i + 1).join("\n").trim();
  // Only strip if the recovery is actually usable; otherwise fail closed downstream.
  if (!isPlausibleTitle(candidate) || rest === "") return trimmed;

  return labelTitle !== null ? `${candidate}\n\n${rest}` : lines.slice(i).join("\n").trim();
}
