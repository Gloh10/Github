import type { Bar } from "./types.js";
import type { Pivot } from "./swings.js";

/** Nearest-bar-by-timestamp lookup, since NQ/ES continuous futures bars aren't guaranteed to share exact timestamps. */
function nearestBar(bars: Bar[], t: number): Bar | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return bars[lo];
}

/**
 * At a given NQ pivot, checks whether ES's corresponding local extreme
 * confirms (moves the same way, similar magnitude) or diverges (SMT).
 * Compares each pivot's extension vs. the immediately preceding same-type
 * NQ pivot, against ES's move over the matching time window.
 */
export function hasSmtDivergence(
  nqPivot: Pivot,
  prevSameTypePivot: Pivot | undefined,
  nqBars: Bar[],
  esBars: Bar[],
  toleranceFraction: number,
): boolean {
  if (!prevSameTypePivot) return false;

  const esAtPivot = nearestBar(esBars, nqBars[nqPivot.barIndex]!.t);
  const esAtPrev = nearestBar(esBars, nqBars[prevSameTypePivot.barIndex]!.t);
  if (!esAtPivot || !esAtPrev) return false;

  const esPivotPrice = nqPivot.type === "high" ? esAtPivot.h : esAtPivot.l;
  const esPrevPrice = nqPivot.type === "high" ? esAtPrev.h : esAtPrev.l;

  const nqMadeNewExtreme =
    nqPivot.type === "high" ? nqPivot.price > prevSameTypePivot.price : nqPivot.price < prevSameTypePivot.price;
  const esMadeNewExtreme =
    nqPivot.type === "high" ? esPivotPrice > esPrevPrice * (1 + toleranceFraction) : esPivotPrice < esPrevPrice * (1 - toleranceFraction);

  // Divergence: NQ confirms a new extreme, ES does not (or vice versa).
  return nqMadeNewExtreme && !esMadeNewExtreme;
}
