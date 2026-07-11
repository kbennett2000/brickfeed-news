/**
 * Markdown → HTML for locally hosted article bodies (ADR-0010).
 *
 * This is the ONE place the render core turns creator-authored markdown into HTML. Unlike the
 * rest of the render (hand-built, escape-everything template literals — see templates.ts), an
 * article Body is real markdown, so we lean on `marked` rather than a hand-rolled parser. That
 * is a deliberate, ADR-recorded exception to the project's minimal-deps convention.
 *
 * Bodies are authored by the site operator (files dropped into `assets/articles/`), i.e. a
 * trusted source, so `marked`'s default raw-HTML pass-through is acceptable here — we do NOT
 * sanitize. `gfm`/`breaks` give a newline-friendly, newspaper-ish rendering. Called
 * synchronously (`async: false`) so the render stays pure and sync.
 */
import { marked } from "marked";

/** Render a markdown string to an HTML fragment. Empty/blank input yields "". */
export function renderMarkdown(md: string): string {
  if (!md || md.trim().length === 0) return "";
  return marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
}
