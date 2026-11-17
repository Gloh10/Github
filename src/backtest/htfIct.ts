import { findFvgs, type FairValueGap } from "./fvg.js";
import type { Bar, Direction } from "./types.js";

// -----------------------------------------------------------------------------
// Higher-timeframe ICT primitives. Everything here is pure price geometry with
// no session/clock-time assumptions (unlike AMD/Kill Zones/Silver Bullet/CRT,
// which are intraday-session-specific and have no higher-timeframe analog --
// deliberately not translated here). Each function works on whatever
// resolution bars it's given (daily, weekly, or monthly).
// -----------------------------------------------------------------------------

/**
 * Generalized sweep-and-reclaim directional bias, keyed by an arbitrary
 * higher period (e.g. ISO week key for a "weekly bias" computed off daily
 * bars, or "YYYY-MM" for a "monthly bias"). Same mechanics as the NQ
 * project's computeDailyBias (which is hardcoded to nyDateKey/daily
 * sessions): the first sweep of the PRIOR period's high or low that closes
 * back through that level within sweepReclaimWindowBars sets the current
 * period's bias, held until the period key changes.
 */
export function computePeriodBias(
  bars: Bar[],
  periodKeyFn: (unixSeconds: number) => string,
  sweepReclaimWindowBars: number,
): (Direction | null)[] {
  const biasByBar: (Direction | null)[] = new Array(bars.length).fill(null);

  const periodHighLow = new Map<string, { high: number; low: number }>();
  for (const bar of bars) {
    const key = periodKeyFn(bar.t);
    const cur = periodHighLow.get(key);
    if (!cur) periodHighLow.set(key, { high: bar.h, low: bar.l });
    else {
      cur.high = Math.max(cur.high, bar.h);
      cur.low = Math.min(cur.low, bar.l);
    }
  }
  const sortedKeys = [...periodHighLow.keys()].sort();

  let currentPeriod = "";
  let prevHigh = Infinity;
  let prevLow = -Infinity;
  let bias: Direction | null = null;
  let pendingSweep: { direction: Direction; sweepBarIndex: number } | null = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const key = periodKeyFn(bar.t);
    if (key !== currentPeriod) {
      currentPeriod = key;
      const idx = sortedKeys.indexOf(key);
      const prevKey = idx > 0 ? sortedKeys[idx - 1] : undefined;
      const prevHl = prevKey ? periodHighLow.get(prevKey) : undefined;
      prevHigh = prevHl ? prevHl.high : Infinity;
      prevLow = prevHl ? prevHl.low : -Infinity;
      bias = null;
      pendingSweep = null;
    }

    if (bias === null && pendingSweep) {
      if (i - pendingSweep.sweepBarIndex > sweepReclaimWindowBars) {
        pendingSweep = null;
      } else {
        const reclaimed = pendingSweep.direction === "long" ? bar.c > prevLow : bar.c < prevHigh;
        if (reclaimed) {
          bias = pendingSweep.direction;
          pendingSweep = null;
        }
      }
    }
    if (bias === null && !pendingSweep) {
      if (bar.l < prevLow) pendingSweep = { direction: "long", sweepBarIndex: i };
      else if (bar.h > prevHigh) pendingSweep = { direction: "short", sweepBarIndex: i };
    }

    biasByBar[i] = bias;
  }

  return biasByBar;
}

function periodKeyWeekly(t: number): string {
  // ISO-ish week key: YYYY-Www, derived from the UTC date (resampled weekly
  // bars already carry one bar per week, so day-level precision isn't needed).
  const d = new Date(t * 1000);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function monthKeyFn(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function weekKeyFn(t: number): string {
  return periodKeyWeekly(t);
}

export interface OrderBlock {
  barIndex: number; // the OB candle itself
  high: number;
  low: number;
  direction: "bullish" | "bearish"; // bullish OB precedes bullish displacement
  displacementFvgBarIndex: number; // the FVG whose formation identified this OB
}

/**
 * Order Block: the last opposite-colour candle before a displacement move,
 * where displacement is evidenced by a resulting FVG (the same objective
 * 3-candle imbalance test already used for the NQ project, reused here
 * unchanged since it's timeframe-agnostic). For a bullish FVG (candles
 * i-2, i-1, i), the OB is the last bearish candle at or before i-2; for a
 * bearish FVG, the last bullish candle at or before i-2.
 */
export function findOrderBlocks(bars: Bar[], fvgs: FairValueGap[]): OrderBlock[] {
  const obs: OrderBlock[] = [];
  for (const fvg of fvgs) {
    const c1Index = fvg.barIndex - 1; // candle 1 of the 3-candle FVG pattern
    const wantBullishCandle = fvg.direction === "bearish"; // OB opposite the displacement
    let obIndex = -1;
    for (let j = c1Index; j >= 0; j--) {
      const bar = bars[j]!;
      const isBullishCandle = bar.c > bar.o;
      if (wantBullishCandle === isBullishCandle && bar.c !== bar.o) {
        obIndex = j;
        break;
      }
    }
    if (obIndex < 0) continue;
    const obBar = bars[obIndex]!;
    obs.push({
      barIndex: obIndex,
      high: obBar.h,
      low: obBar.l,
      direction: fvg.direction === "bullish" ? "bullish" : "bearish",
      displacementFvgBarIndex: fvg.barIndex,
    });
  }
  return obs;
}

export interface BreakerBlock {
  barIndex: number; // original OB candle index
  high: number;
  low: number;
  direction: "bullish" | "bearish"; // direction AFTER the flip (opposite of the original OB)
  violatedAtBarIndex: number;
}

/**
 * Breaker Block: an Order Block later violated by a close through its far
 * side. A bullish OB (support) whose low is closed below becomes a bearish
 * Breaker (now resistance); a bearish OB whose high is closed above becomes
 * a bullish Breaker. Only the first violation per OB is recorded.
 */
export function findBreakerBlocks(bars: Bar[], orderBlocks: OrderBlock[]): BreakerBlock[] {
  const breakers: BreakerBlock[] = [];
  for (const ob of orderBlocks) {
    for (let i = ob.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      if (ob.direction === "bullish" && bar.c < ob.low) {
        breakers.push({ barIndex: ob.barIndex, high: ob.high, low: ob.low, direction: "bearish", violatedAtBarIndex: i });
        break;
      }
      if (ob.direction === "bearish" && bar.c > ob.high) {
        breakers.push({ barIndex: ob.barIndex, high: ob.high, low: ob.low, direction: "bullish", violatedAtBarIndex: i });
        break;
      }
    }
  }
  return breakers;
}

export interface InversionFvg {
  barIndex: number;
  top: number;
  bottom: number;
  direction: "bullish" | "bearish"; // direction AFTER the flip
  violatedAtBarIndex: number;
}

/** Inversion FVG: an FVG violated by an opposite-direction close through the whole gap, flipping it into an entry zone the other way. */
export function findInversionFvgs(bars: Bar[], fvgs: FairValueGap[]): InversionFvg[] {
  const out: InversionFvg[] = [];
  for (const fvg of fvgs) {
    for (let i = fvg.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      if (fvg.direction === "bullish" && bar.c < fvg.bottom) {
        out.push({ barIndex: fvg.barIndex, top: fvg.top, bottom: fvg.bottom, direction: "bearish", violatedAtBarIndex: i });
        break;
      }
      if (fvg.direction === "bearish" && bar.c > fvg.top) {
        out.push({ barIndex: fvg.barIndex, top: fvg.top, bottom: fvg.bottom, direction: "bullish", violatedAtBarIndex: i });
        break;
      }
    }
  }
  return out;
}

export interface BalancedPriceRange {
  top: number;
  bottom: number;
  bullishFvgBarIndex: number;
  bearishFvgBarIndex: number;
}

/** Balanced Price Range: the overlap zone where a bearish FVG and a bullish FVG intersect at the same price levels -- bidirectional institutional interest, highest-priority PD array per the ICT hierarchy. */
export function findBalancedPriceRanges(fvgs: FairValueGap[]): BalancedPriceRange[] {
  const bullish = fvgs.filter((f) => f.direction === "bullish");
  const bearish = fvgs.filter((f) => f.direction === "bearish");
  const out: BalancedPriceRange[] = [];
  for (const b of bullish) {
    for (const s of bearish) {
      const top = Math.min(b.top, s.top);
      const bottom = Math.max(b.bottom, s.bottom);
      if (top > bottom) {
        out.push({ top, bottom, bullishFvgBarIndex: b.barIndex, bearishFvgBarIndex: s.barIndex });
      }
    }
  }
  return out;
}

export { findFvgs };
