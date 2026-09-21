import type { Bar } from "./types.js";

export interface FairValueGap {
  barIndex: number; // the middle (displacement) candle
  top: number;
  bottom: number;
  direction: "bullish" | "bearish";
}

/**
 * Standard 3-candle fair value gap: candle 1's high/low doesn't overlap
 * candle 3's low/high, leaving an imbalance. Objective, not an approximation.
 */
export function findFvgs(bars: Bar[]): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2]!;
    const c3 = bars[i]!;
    if (c1.h < c3.l) {
      gaps.push({ barIndex: i - 1, top: c3.l, bottom: c1.h, direction: "bullish" });
    } else if (c1.l > c3.h) {
      gaps.push({ barIndex: i - 1, top: c1.l, bottom: c3.h, direction: "bearish" });
    }
  }
  return gaps;
}
