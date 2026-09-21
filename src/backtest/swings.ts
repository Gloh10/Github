import type { Bar } from "./types.js";

export interface Pivot {
  barIndex: number;
  price: number;
  type: "high" | "low";
}

/**
 * Fractal pivot detection: a bar is a pivot high/low if its high/low is the
 * most extreme within `confirm` bars on each side. This stands in for the
 * "manipulation leg" the trader selects by eye — it will not always agree
 * with a discretionary choice, and that gap is the single biggest source of
 * divergence between this backtest and how the strategy is actually traded.
 */
export function findPivots(bars: Bar[], confirm: number): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = confirm; i < bars.length - confirm; i++) {
    const bar = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - confirm; j <= i + confirm; j++) {
      if (j === i) continue;
      if (bars[j]!.h >= bar.h) isHigh = false;
      if (bars[j]!.l <= bar.l) isLow = false;
    }
    if (isHigh) pivots.push({ barIndex: i, price: bar.h, type: "high" });
    if (isLow) pivots.push({ barIndex: i, price: bar.l, type: "low" });
  }
  return pivots;
}

export interface Leg {
  originIndex: number; // the "0" point, extensions project beyond this
  originPrice: number;
  extremeIndex: number; // the "1" point
  extremePrice: number;
  direction: "up" | "down"; // "up" = origin is the low, extreme is the high
}

/** Builds legs from consecutive alternating pivots (low->high or high->low), wick-to-wick. */
export function buildLegs(pivots: Pivot[]): Leg[] {
  const legs: Leg[] = [];
  for (let i = 1; i < pivots.length; i++) {
    const a = pivots[i - 1]!;
    const b = pivots[i]!;
    if (a.type === b.type) continue;
    if (a.type === "low" && b.type === "high") {
      legs.push({
        originIndex: a.barIndex,
        originPrice: a.price,
        extremeIndex: b.barIndex,
        extremePrice: b.price,
        direction: "up",
      });
    } else if (a.type === "high" && b.type === "low") {
      legs.push({
        originIndex: a.barIndex,
        originPrice: a.price,
        extremeIndex: b.barIndex,
        extremePrice: b.price,
        direction: "down",
      });
    }
  }
  return legs;
}

/**
 * "Standard Deviation" extension levels (ICT-retail terminology, not
 * statistical std-dev) — multiples of the leg length projected beyond the
 * origin, in the direction opposite the leg's own impulse (i.e. where price
 * is expected to reverse/continue toward after retracing past the origin).
 */
export function sdLevels(leg: Leg, multiples: number[]): Record<string, number> {
  const length = Math.abs(leg.extremePrice - leg.originPrice);
  const out: Record<string, number> = {};
  for (const m of multiples) {
    const level = leg.direction === "up" ? leg.originPrice - m * length : leg.originPrice + m * length;
    out[`-${m}`] = level;
  }
  return out;
}

/** OTE retracement zone (61.8%-78.6%) back into the leg from its extreme. */
export function oteZone(leg: Leg): { near: number; far: number } {
  const length = Math.abs(leg.extremePrice - leg.originPrice);
  if (leg.direction === "up") {
    return { near: leg.extremePrice - 0.618 * length, far: leg.extremePrice - 0.786 * length };
  }
  return { near: leg.extremePrice + 0.618 * length, far: leg.extremePrice + 0.786 * length };
}
