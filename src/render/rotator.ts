/**
 * The banner-ad rotator (ADR-0017): a per-page-load shuffled crossfade, replacing the
 * old build-time CSS keyframes whose timing was baked (per ad count) into the day-cached
 * stylesheet — the root cause of slides desyncing whenever HTML and CSS aged apart, and
 * of the identical play order on every load.
 *
 * The algorithm lives in the pure functions below, unit-tested directly, and the SAME
 * functions are embedded into the shipped inline script via `Function.prototype.toString()`
 * — one definition, no test/ship drift. They must therefore stay self-contained: no
 * imports, no captured module state, ES5-compatible bodies.
 *
 * The DOM driver reads each slide's `data-duration` (milliseconds, emitted from the
 * sidecar-validated AdView), shuffles once, then cycles in that order — so every ad
 * appears exactly once per pass and there are no adjacent repeats. It bails (leaving the
 * stylesheet's static first-slide fallback) when JS is off, on `prefers-reduced-motion`,
 * or with fewer than two slides.
 */

/** Fisher-Yates over the indices `[0..n)`. `rand` is injectable for seeded tests. */
export function shuffleIndices(n: number, rand: () => number): number[] {
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

/** One shuffled pass: every slide exactly once, each carrying its own duration. */
export function buildAdQueue(
  durationsMs: number[],
  rand: () => number,
): Array<{ index: number; durationMs: number }> {
  return shuffleIndices(durationsMs.length, rand).map((index) => ({
    index,
    durationMs: durationsMs[index]!,
  }));
}

/**
 * The inline `<script>` body the banner template ships (only on pages with 2+ ads).
 * `data-duration` is trusted but re-validated as defense-in-depth — the sidecar parser
 * guarantees a bounded value, so the 7000ms fallback should never fire in practice.
 */
export const AD_ROTATOR_JS = `(function () {
  "use strict";
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var frame = document.querySelector(".adbanner__frame");
  if (!frame) return;
  var slides = frame.querySelectorAll(".adbanner__slide");
  if (slides.length < 2) return;
  var shuffleIndices = ${shuffleIndices.toString()};
  var buildAdQueue = ${buildAdQueue.toString()};
  var durations = [];
  for (var i = 0; i < slides.length; i++) {
    var d = parseInt(slides[i].getAttribute("data-duration"), 10);
    durations.push(isFinite(d) && d > 0 ? d : 7000);
  }
  var queue = buildAdQueue(durations, Math.random);
  frame.classList.add("is-live");
  var pos = 0;
  var current = null;
  function step() {
    if (current) current.classList.remove("is-active");
    var entry = queue[pos];
    current = slides[entry.index];
    current.classList.add("is-active");
    pos = (pos + 1) % queue.length;
    setTimeout(step, entry.durationMs);
  }
  step();
})();`;
