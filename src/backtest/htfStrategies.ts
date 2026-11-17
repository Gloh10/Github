import { isBearishEngulfing, isBullishEngulfing, isHammer, isShootingStar } from "./candlePatterns.js";
import { findBalancedPriceRanges, findOrderBlocks, type OrderBlock } from "./htfIct.js";
import { findFvgs } from "./fvg.js";
import { buildLegs, findPivots, oteZone } from "./swings.js";
import type { Bar, Direction, Signal } from "./types.js";

/** Binary search: first index in `times` (ascending) at or after `t`. */
function firstIndexAtOrAfter(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Strategy A -- "Monthly bias + Weekly Order Block entry": a position-trade
 * model. Weekly OBs matching the monthly bias at their bar are the setup;
 * the entry trigger (first daily close back into the OB's range after it
 * formed) and trade resolution both run on DAILY bars for realistic
 * granularity, mirroring how the NQ project's hourly-SFP/5-min-entry setup
 * (strategies.ts Setup 6) maps a coarser signal onto a finer entry
 * resolution. Target is the nearest weekly swing pivot ahead of entry in
 * the bias direction (the "next opposing liquidity pool"); falls back to a
 * fixed R-multiple if none exists within the data.
 */
export function buildMonthlyBiasWeeklyObSignals(
  dailyBars: Bar[],
  weeklyBars: Bar[],
  monthlyBiasPerWeeklyBar: (Direction | null)[],
  opts: { weeklyPivotConfirm: number; fallbackTargetR: number; requireBprConfluence?: boolean; disablePivotTarget?: boolean },
): Signal[] {
  const weeklyFvgs = findFvgs(weeklyBars);
  const weeklyObs = findOrderBlocks(weeklyBars, weeklyFvgs);
  const weeklyPivots = findPivots(weeklyBars, opts.weeklyPivotConfirm);
  const bprs = opts.requireBprConfluence ? findBalancedPriceRanges(weeklyFvgs) : [];
  const dailyTimes = dailyBars.map((b) => b.t);

  const signals: Signal[] = [];
  let openUntilDailyIndex = -1;

  const candidates = weeklyObs
    .map((ob) => ({ ob, direction: (ob.direction === "bullish" ? "long" : "short") as Direction }))
    .filter(({ ob, direction }) => monthlyBiasPerWeeklyBar[ob.barIndex] === direction)
    .filter(({ ob }) => {
      if (!opts.requireBprConfluence) return true;
      return bprs.some((bpr) => Math.min(ob.high, bpr.top) >= Math.max(ob.low, bpr.bottom));
    });

  for (const { ob, direction } of candidates) {
    // Find the first weekly bar AFTER the OB that touches back into its range.
    let touchWeeklyIdx = -1;
    for (let w = ob.barIndex + 1; w < weeklyBars.length; w++) {
      const wb = weeklyBars[w]!;
      if (wb.l <= ob.high && wb.h >= ob.low) {
        touchWeeklyIdx = w;
        break;
      }
    }
    if (touchWeeklyIdx < 0) continue;

    // Map that weekly bar's time range onto daily bars to find the precise entry day.
    const weekStartT = weeklyBars[touchWeeklyIdx]!.t;
    const weekEndT = touchWeeklyIdx + 1 < weeklyBars.length ? weeklyBars[touchWeeklyIdx + 1]!.t : Infinity;
    const dayStart = firstIndexAtOrAfter(dailyTimes, weekStartT);
    const dayEnd = weekEndT === Infinity ? dailyBars.length - 1 : firstIndexAtOrAfter(dailyTimes, weekEndT) - 1;

    let entryDayIdx = -1;
    for (let d = Math.max(dayStart, openUntilDailyIndex + 1); d <= dayEnd && d < dailyBars.length; d++) {
      const db = dailyBars[d]!;
      if (db.l <= ob.high && db.h >= ob.low) {
        // The bar must also CLOSE on the correct side of the OB's stop level --
        // a bar that merely wicks through the zone and closes back out the far
        // side has already invalidated the setup, not confirmed an entry.
        const closedOnCorrectSide = direction === "long" ? db.c > ob.low : db.c < ob.high;
        if (closedOnCorrectSide) {
          entryDayIdx = d;
          break;
        }
      }
    }
    if (entryDayIdx < 0) continue;
    if (entryDayIdx <= openUntilDailyIndex) continue;

    const entry = dailyBars[entryDayIdx]!.c;
    const stop = direction === "long" ? ob.low : ob.high;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;

    const fuelLevels = opts.disablePivotTarget
      ? []
      : weeklyPivots
          .filter((p) => p.barIndex > touchWeeklyIdx)
          .filter((p) => (direction === "long" ? p.type === "high" && p.price > entry : p.type === "low" && p.price < entry));
    const nearestFuel =
      fuelLevels.length > 0
        ? direction === "long"
          ? Math.min(...fuelLevels.map((p) => p.price))
          : Math.max(...fuelLevels.map((p) => p.price))
        : null;
    const target = nearestFuel !== null ? nearestFuel : direction === "long" ? entry + risk * opts.fallbackTargetR : entry - risk * opts.fallbackTargetR;

    signals.push({
      barIndex: entryDayIdx,
      direction,
      entry,
      stop,
      target,
      reason: `monthly bias (${direction}) + weekly OB@${ob.barIndex} touch, entry daily@${entryDayIdx}${nearestFuel !== null ? ", target=nearest weekly pivot" : `, target=fallback ${opts.fallbackTargetR}R`}`,
    });
    openUntilDailyIndex = entryDayIdx; // conservative: one open position at a time, approximated here by entry index
  }

  return signals.sort((a, b) => a.barIndex - b.barIndex);
}

/**
 * Strategy B -- "Weekly bias + Daily OTE entry": a swing-trade model. Daily
 * swing legs matching the weekly bias get their OTE zone (61.8%-78.6%
 * retracement) computed; entry fires when price retraces into that zone and
 * a reversal candle confirms, same confirmation style as the NQ project's
 * mean-reversion/trend-continuation setups. Fixed R-multiple target/stop.
 */
export function buildWeeklyBiasDailyOteSignals(
  dailyBars: Bar[],
  weeklyBiasPerDailyBar: (Direction | null)[],
  opts: { dailyPivotConfirm: number; targetR: number },
): Signal[] {
  const pivots = findPivots(dailyBars, opts.dailyPivotConfirm);
  const legs = buildLegs(pivots);
  const signals: Signal[] = [];

  for (const leg of legs) {
    const legDirection: Direction = leg.direction === "up" ? "long" : "short";
    const biasAtExtreme = weeklyBiasPerDailyBar[leg.extremeIndex];
    if (biasAtExtreme !== legDirection) continue;

    const ote = oteZone(leg);
    const zoneLow = Math.min(ote.near, ote.far);
    const zoneHigh = Math.max(ote.near, ote.far);

    for (let i = leg.extremeIndex + 1; i < dailyBars.length; i++) {
      const bar = dailyBars[i]!;
      const prev = dailyBars[i - 1]!;
      const touched = bar.l <= zoneHigh && bar.h >= zoneLow;
      if (!touched) continue;

      const confirmed =
        legDirection === "long" ? isHammer(bar) || isBullishEngulfing(prev, bar) : isShootingStar(bar) || isBearishEngulfing(prev, bar);
      if (!confirmed) break; // only the first touch counts; if it doesn't confirm, the OTE setup is spent

      const entry = bar.c;
      const stop = legDirection === "long" ? Math.min(bar.l, zoneLow) : Math.max(bar.h, zoneHigh);
      const risk = Math.abs(entry - stop);
      if (risk <= 0) break;
      const target = legDirection === "long" ? entry + risk * opts.targetR : entry - risk * opts.targetR;

      signals.push({
        barIndex: i,
        direction: legDirection,
        entry,
        stop,
        target,
        reason: `weekly bias (${legDirection}) + daily OTE entry on leg ${leg.originIndex}->${leg.extremeIndex}`,
      });
      break;
    }
  }

  return signals.sort((a, b) => a.barIndex - b.barIndex);
}

export type { OrderBlock };
