import { nyDateKey } from "./nyTime.js";
import { findPivots, type Pivot } from "./swings.js";
import type { Bar } from "./types.js";

/**
 * Mechanical approximations of four ICT/SMC "liquidity" concepts, each
 * disclosed here since none of them have one universally-agreed definition:
 *
 * - Equal highs/lows (EQH/EQL): two or more fractal pivots of the same type
 *   sitting within `tolerancePct` of each other's price — the textbook
 *   "liquidity pool" a resting-stop cluster is expected to sit at.
 * - Daily highs/lows: the prior NY day's high/low, the most basic
 *   liquidity reference level (reused from the same logic as Setup 9).
 * - Daily wicks: a daily candle whose upper or lower wick is at least
 *   `minWickFraction` of that day's full range — read as "this day already
 *   swept liquidity here," marking the wick's extreme as a level.
 * - LRLR ("low resistance liquidity run"): no opposing-type pivot sits
 *   between an entry and its target — i.e. nothing structurally in the way
 *   before price reaches the level being targeted.
 *
 * All four are proximity/structure checks against a single price level, not
 * signal generators — meant to be used as confluence filters on top of an
 * existing strategy's signals.
 */

export interface LiquidityLevel {
  price: number;
  barIndex: number; // the pivot/day/wick this level came from
}

export function equalHighsLows(bars: Bar[], pivotConfirm: number, tolerancePct: number): { highs: LiquidityLevel[]; lows: LiquidityLevel[] } {
  const pivots = findPivots(bars, pivotConfirm);
  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");

  const cluster = (points: Pivot[]): LiquidityLevel[] => {
    const levels: LiquidityLevel[] = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!;
        const b = points[j]!;
        if (Math.abs(a.price - b.price) / a.price <= tolerancePct) {
          levels.push({ price: b.price, barIndex: b.barIndex }); // the later pivot is when the pool becomes "equal"
        }
      }
    }
    return levels;
  };

  return { highs: cluster(highs), lows: cluster(lows) };
}

export function priorDayHighLow(bars: Bar[]): { high: number; low: number }[] {
  const dailyHighLow = new Map<string, { high: number; low: number }>();
  for (const bar of bars) {
    const key = nyDateKey(bar.t);
    const cur = dailyHighLow.get(key);
    if (!cur) dailyHighLow.set(key, { high: bar.h, low: bar.l });
    else {
      cur.high = Math.max(cur.high, bar.h);
      cur.low = Math.min(cur.low, bar.l);
    }
  }
  const sortedDayKeys = [...dailyHighLow.keys()].sort();

  const result: { high: number; low: number }[] = [];
  let currentDay = "";
  let prevHigh = Infinity;
  let prevLow = -Infinity;
  for (const bar of bars) {
    const dayKey = nyDateKey(bar.t);
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      const idx = sortedDayKeys.indexOf(dayKey);
      const prevKey = idx > 0 ? sortedDayKeys[idx - 1] : undefined;
      const prevHL = prevKey ? dailyHighLow.get(prevKey) : undefined;
      prevHigh = prevHL ? prevHL.high : Infinity;
      prevLow = prevHL ? prevHL.low : -Infinity;
    }
    result.push({ high: prevHigh, low: prevLow });
  }
  return result;
}

export function dailyWickLevels(bars: Bar[], minWickFraction: number): { upperWicks: LiquidityLevel[]; lowerWicks: LiquidityLevel[] } {
  interface DailyCandle {
    dayKey: string;
    barIndex: number; // last bar of the day, used as the level's "confirmed" index
    o: number;
    h: number;
    l: number;
    c: number;
  }
  const byDay = new Map<string, DailyCandle>();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const key = nyDateKey(bar.t);
    const cur = byDay.get(key);
    if (!cur) byDay.set(key, { dayKey: key, barIndex: i, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
    else {
      cur.barIndex = i;
      cur.h = Math.max(cur.h, bar.h);
      cur.l = Math.min(cur.l, bar.l);
      cur.c = bar.c;
    }
  }

  const upperWicks: LiquidityLevel[] = [];
  const lowerWicks: LiquidityLevel[] = [];
  for (const day of byDay.values()) {
    const range = day.h - day.l;
    if (range <= 0) continue;
    const bodyTop = Math.max(day.o, day.c);
    const bodyBottom = Math.min(day.o, day.c);
    const upperWick = day.h - bodyTop;
    const lowerWick = bodyBottom - day.l;
    if (upperWick / range >= minWickFraction) upperWicks.push({ price: day.h, barIndex: day.barIndex });
    if (lowerWick / range >= minWickFraction) lowerWicks.push({ price: day.l, barIndex: day.barIndex });
  }
  return { upperWicks, lowerWicks };
}

export function isNearLevel(price: number, levels: LiquidityLevel[], asOfBarIndex: number, tolerancePct: number): boolean {
  return levels.some((l) => l.barIndex < asOfBarIndex && Math.abs(l.price - price) / price <= tolerancePct);
}

/** LRLR: true if no opposing-type pivot sits strictly between entry and target. */
export function hasLowResistanceRun(pivots: Pivot[], entryBarIndex: number, entryPrice: number, targetPrice: number, direction: "long" | "short"): boolean {
  const blockingType = direction === "long" ? "high" : "low";
  const lo = Math.min(entryPrice, targetPrice);
  const hi = Math.max(entryPrice, targetPrice);
  return !pivots.some((p) => p.type === blockingType && p.barIndex < entryBarIndex && p.price > lo && p.price < hi);
}
