/**
 * Wrap Claude's neutral image prompt with the configurable toy-brick style
 * language (ADR decision #7). PURE and standalone: the style text is supplied by
 * the caller (from config), never hardcoded here, so the brick aesthetic can be
 * tuned without touching code. The imagegen service is prompt-agnostic; this is
 * where the story's neutral scene becomes a styled scene.
 *
 * Join format: the style language first (it sets the overall medium/aesthetic),
 * then the specific scene. Both are trimmed and combined into one prompt string.
 */
export function wrapBrickStyle(imagePrompt: string, styleLanguage: string): string {
  const style = styleLanguage.trim();
  const scene = imagePrompt.trim();
  if (!scene) return style;
  return `${style} Scene: ${scene}`;
}
