import { isBearishEngulfing, isBullishEngulfing, isHammer, isShootingStar } from "./candlePatterns.js";
import { findFvgs } from "./fvg.js";
import type { VwapPoint } from "./indicators.js";
import { hasSmtDivergence } from "./smt.js";
import { buildLegs, findPivots, oteZone, sdLevels, type Pivot } from "./swings.js";
import { nyDateKey, nyHour } from "./nyTime.js";
import type { Bar, Signal } from "./types.js";
import type { ValueArea } from "./volumeProfile.js";

const TARGET_R_MULTIPLE = 2;

function dayKey(bar: Bar): string {
  return new Date(bar.t * 1000).toISOString().slice(0, 10);
}

function slopePct(vwap: VwapPoint[], i: number, lookback: number): number {
  const j = Math.max(0, i - lookback);
  const past = vwap[j]!.vwap;
  return past === 0 ? 0 : ((vwap[i]!.vwap - past) / past) * 100;
}

/**
 * Setup 1 — "Sub-VWAP Trap" (mechanical approximation of the discretionary
 * Warrior Trading setup). The original entry trigger is read from live
 * level-2/time-and-sales order flow, which historical OHLCV bars cannot
 * reconstruct — this substitutes a bar-close reclaim of VWAP after
 * repeated failed attempts. squeezeThresholdPct controls how large the
 * prior intraday extension must have been before the pullback; the source
 * material used ~10% (small-cap context), which is scaled down here for a
 * large, liquid index future where 10% intraday moves essentially never
 * occur — see the report for the as-specified (10%) run, which is expected
 * to find ~0 setups on NQ.
 */
export function subVwapTrap(
  bars: Bar[],
  vwap: VwapPoint[],
  opts: { squeezeThresholdPct: number; minFailedAttempts: number },
): Signal[] {
  const signals: Signal[] = [];
  let sessionOpen = bars[0]!.o;
  let sessionHigh = bars[0]!.h;
  let sessionKey = dayKey(bars[0]!);
  let squeezed = false;
  let failedAttempts = 0;
  let wasAboveVwap = false;
  let inPosition = false;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const key = dayKey(bar);
    if (key !== sessionKey) {
      sessionKey = key;
      sessionOpen = bar.o;
      sessionHigh = bar.h;
      squeezed = false;
      failedAttempts = 0;
      wasAboveVwap = false;
      inPosition = false;
    }
    sessionHigh = Math.max(sessionHigh, bar.h);

    const extensionPct = ((sessionHigh - sessionOpen) / sessionOpen) * 100;
    if (extensionPct >= opts.squeezeThresholdPct) squeezed = true;

    const closeAboveVwap = bar.c > vwap[i]!.vwap;

    if (squeezed && !inPosition) {
      if (wasAboveVwap && !closeAboveVwap) {
        failedAttempts += 1; // touched/closed above, then fell back below
      }
      if (!wasAboveVwap && closeAboveVwap && failedAttempts >= opts.minFailedAttempts) {
        signals.push({
          barIndex: i,
          direction: "long",
          entry: bar.c,
          stop: bar.l,
          target: bar.c + (bar.c - bar.l) * TARGET_R_MULTIPLE,
          reason: `sub-vwap-trap reclaim after ${failedAttempts} failed attempts, prior extension ${extensionPct.toFixed(1)}%`,
        });
        inPosition = true;
      }
    }
    wasAboveVwap = closeAboveVwap;
  }

  return signals;
}

/**
 * Setup 1, daily-bar variant. The session-reset logic in subVwapTrap has no
 * meaning when every bar is its own "session," so the squeeze precondition
 * here is instead "up >= squeezeThresholdPct% from the lowest close in the
 * prior squeezeLookback bars," using a rolling (non-resetting) VWAP.
 */
export function subVwapTrapDaily(
  bars: Bar[],
  vwap: VwapPoint[],
  opts: { squeezeLookback: number; squeezeThresholdPct: number; minFailedAttempts: number },
): Signal[] {
  const signals: Signal[] = [];
  let failedAttempts = 0;
  let wasAboveVwap = true;
  let inPosition = false;

  for (let i = opts.squeezeLookback; i < bars.length; i++) {
    const bar = bars[i]!;
    let lowestClose = Infinity;
    for (let j = i - opts.squeezeLookback; j < i; j++) {
      lowestClose = Math.min(lowestClose, bars[j]!.c);
    }
    const extensionPct = ((bar.c - lowestClose) / lowestClose) * 100;
    const squeezed = extensionPct >= opts.squeezeThresholdPct;
    const closeAboveVwap = bar.c > vwap[i]!.vwap;

    if (squeezed) {
      if (wasAboveVwap && !closeAboveVwap) {
        failedAttempts += 1;
        inPosition = false;
      }
      if (!wasAboveVwap && closeAboveVwap && failedAttempts >= opts.minFailedAttempts && !inPosition) {
        signals.push({
          barIndex: i,
          direction: "long",
          entry: bar.c,
          stop: bar.l,
          target: bar.c + (bar.c - bar.l) * TARGET_R_MULTIPLE,
          reason: `daily sub-vwap-trap reclaim after ${failedAttempts} failed attempts, extension ${extensionPct.toFixed(1)}%`,
        });
        inPosition = true;
      }
    }
    wasAboveVwap = closeAboveVwap;
  }

  return signals;
}

/**
 * Setup 2 — VWAP mean reversion. Fires only when VWAP is "flat" (slope
 * below flatSlopePct over the lookback window) and price tags band 2 with
 * a confirming reversal candle.
 */
export function vwapMeanReversion(
  bars: Bar[],
  vwap: VwapPoint[],
  opts: { flatSlopePct: number; slopeLookback: number },
): Signal[] {
  const signals: Signal[] = [];

  for (let i = opts.slopeLookback; i < bars.length; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1]!;
    const isFlat = Math.abs(slopePct(vwap, i, opts.slopeLookback)) <= opts.flatSlopePct;
    if (!isFlat) continue;

    const touchedUpper = bar.h >= vwap[i]!.upperBand2;
    const touchedLower = bar.l <= vwap[i]!.lowerBand2;

    if (touchedUpper && (isShootingStar(bar) || isBearishEngulfing(prev, bar))) {
      signals.push({
        barIndex: i,
        direction: "short",
        entry: bar.c,
        stop: bar.h,
        target: vwap[i]!.vwap,
        reason: "mean-reversion short: band2 tag + reversal candle, flat VWAP",
      });
    } else if (touchedLower && (isHammer(bar) || isBullishEngulfing(prev, bar))) {
      signals.push({
        barIndex: i,
        direction: "long",
        entry: bar.c,
        stop: bar.l,
        target: vwap[i]!.vwap,
        reason: "mean-reversion long: band2 tag + reversal candle, flat VWAP",
      });
    }
  }

  return signals;
}

/**
 * Setup 3 — VWAP trend continuation. Fires only when VWAP is clearly
 * sloping, on a pullback to VWAP/band1 confirmed by a trend-aligned candle.
 */
export function vwapTrendContinuation(
  bars: Bar[],
  vwap: VwapPoint[],
  opts: { trendSlopePct: number; slopeLookback: number },
): Signal[] {
  const signals: Signal[] = [];

  for (let i = opts.slopeLookback; i < bars.length; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1]!;
    const slope = slopePct(vwap, i, opts.slopeLookback);

    if (slope >= opts.trendSlopePct) {
      const pulledBack = bar.l <= vwap[i]!.vwap || bar.l <= vwap[i]!.lowerBand1;
      if (pulledBack && (isHammer(bar) || isBullishEngulfing(prev, bar))) {
        signals.push({
          barIndex: i,
          direction: "long",
          entry: bar.c,
          stop: bar.l,
          target: bar.c + (bar.c - bar.l) * TARGET_R_MULTIPLE,
          reason: `trend continuation long: pullback to VWAP, slope ${slope.toFixed(2)}%`,
        });
      }
    } else if (slope <= -opts.trendSlopePct) {
      const pulledBack = bar.h >= vwap[i]!.vwap || bar.h >= vwap[i]!.upperBand1;
      if (pulledBack && (isShootingStar(bar) || isBearishEngulfing(prev, bar))) {
        signals.push({
          barIndex: i,
          direction: "short",
          entry: bar.c,
          stop: bar.h,
          target: bar.c - (bar.h - bar.c) * TARGET_R_MULTIPLE,
          reason: `trend continuation short: pullback to VWAP, slope ${slope.toFixed(2)}%`,
        });
      }
    }
  }

  return signals;
}

/**
 * Setup 5 — "Standard Deviation + OTE" (ICT-style), combined from 4 video
 * transcripts (3 trade recaps + a "key opens" explainer). This is the most
 * discretionary setup tested so far — see the report notes for the specific
 * approximations made: fractal pivots stand in for the trader's by-eye
 * "manipulation leg" selection, order blocks/rejection blocks are NOT
 * modeled (too fuzzy to codify responsibly), and "key opens" are reduced to
 * just the daily session open (not midnight/10am specifically, which need
 * NY-timezone handling not implemented here).
 *
 * Logic: build legs from fractal pivots; a leg's negative "standard
 * deviation" extensions (multiples of the leg length, projected beyond its
 * origin) are the zone price is expected to react at. A touch of one of
 * those levels (-2, -2.5, -4, -4.5 — per the stated rule that -1 is "just a
 * pullback," not a reaction level), confirmed by (a) overlap with that same
 * leg's OTE retracement zone and/or (b) an FVG and/or (c) proximity to the
 * daily open, plus a reversal candle, triggers an entry counter to the
 * extension — i.e. back toward the leg's origin ("the zero"), which is the
 * target.
 */
export function standardDeviationOte(
  bars: Bar[],
  opts: {
    pivotConfirm: number;
    minConfluence: number; // 1 = SD level alone; 2 = SD level + one more
    toleranceFraction: number; // price tolerance for "clustering", e.g. 0.0015 = 0.15%
    esBars?: Bar[]; // if provided, requires SMT divergence confirmation (no contradiction)
    requireSmt?: boolean;
  },
): Signal[] {
  const signals: Signal[] = [];
  const pivots = findPivots(bars, opts.pivotConfirm);
  const legs = buildLegs(pivots);
  const fvgs = findFvgs(bars);
  const sdMultiples = [2, 2.5, 4, 4.5];

  // daily session open per bar index, for the "key open" confluence proxy
  const dailyOpenAt: number[] = [];
  {
    let sessionOpen = bars[0]!.o;
    let sessionKey = new Date(bars[0]!.t * 1000).toISOString().slice(0, 10);
    for (const bar of bars) {
      const key = new Date(bar.t * 1000).toISOString().slice(0, 10);
      if (key !== sessionKey) {
        sessionKey = key;
        sessionOpen = bar.o;
      }
      dailyOpenAt.push(sessionOpen);
    }
  }

  const highPivots = pivots.filter((p) => p.type === "high");
  const lowPivots = pivots.filter((p) => p.type === "low");
  function prevSameType(pivot: Pivot): Pivot | undefined {
    const list = pivot.type === "high" ? highPivots : lowPivots;
    const idx = list.findIndex((p) => p.barIndex === pivot.barIndex);
    return idx > 0 ? list[idx - 1] : undefined;
  }

  let inPosition = false;
  let positionUntilBar = -1;

  for (let i = opts.pivotConfirm * 2; i < bars.length; i++) {
    if (i <= positionUntilBar) continue;
    const bar = bars[i]!;
    const prev = bars[i - 1]!;

    // find legs whose extreme is confirmed on or before this bar, most recent first
    const activeLegs = legs.filter((l) => l.extremeIndex < i).slice(-6);

    for (const leg of activeLegs) {
      const levels = sdLevels(leg, sdMultiples);
      const ote = oteZone(leg);

      for (const key of Object.keys(levels)) {
        const level = levels[key]!;
        const touched = bar.l <= level && bar.h >= level;
        if (!touched) continue;

        let confluence = 1; // the SD level itself
        const oteLow = Math.min(ote.near, ote.far);
        const oteHigh = Math.max(ote.near, ote.far);
        if (level >= oteLow * (1 - opts.toleranceFraction) && level <= oteHigh * (1 + opts.toleranceFraction)) {
          confluence++;
        }
        const nearFvg = fvgs.some(
          (g) => g.barIndex <= i && Math.abs(level - (g.top + g.bottom) / 2) / level <= opts.toleranceFraction,
        );
        if (nearFvg) confluence++;
        const nearDailyOpen = Math.abs(level - dailyOpenAt[i]!) / level <= opts.toleranceFraction;
        if (nearDailyOpen) confluence++;

        if (confluence < opts.minConfluence) continue;

        const direction = leg.direction === "up" ? "long" : "short";
        const confirmed =
          direction === "long"
            ? isHammer(bar) || isBullishEngulfing(prev, bar)
            : isShootingStar(bar) || isBearishEngulfing(prev, bar);
        if (!confirmed) continue;

        if (opts.esBars) {
          const nearestPivot = direction === "long" ? lowPivots.find((p) => p.barIndex >= leg.extremeIndex) : highPivots.find((p) => p.barIndex >= leg.extremeIndex);
          const pivotForSmt = nearestPivot ?? (leg.direction === "up" ? { barIndex: leg.extremeIndex, price: leg.extremePrice, type: "high" as const } : { barIndex: leg.extremeIndex, price: leg.extremePrice, type: "low" as const });
          const prevPivot = prevSameType(pivotForSmt);
          const divergence = hasSmtDivergence(pivotForSmt, prevPivot, bars, opts.esBars, 0.0005);
          if (opts.requireSmt && !divergence) continue;
        }

        if (!inPosition) {
          signals.push({
            barIndex: i,
            direction,
            entry: bar.c,
            stop: direction === "long" ? Math.min(bar.l, level) : Math.max(bar.h, level),
            target: leg.originPrice,
            reason: `SD ${key} touch, confluence=${confluence}, leg ${leg.originIndex}->${leg.extremeIndex}`,
          });
          inPosition = true;
          positionUntilBar = i; // engine's simulateTrades resolves actual exit; this just blocks re-signaling same bar cluster
        }
        break;
      }
    }
    // allow a new position search a few bars later regardless of open trade status (engine enforces one-at-a-time)
    if (i > positionUntilBar + 5) inPosition = false;
  }

  return signals;
}

export interface DetectedSfp {
  hourlyBarIndex: number;
  direction: "long" | "short";
  swingLevel: number;
  stopLevel: number; // the raiding bar's extreme, used for the hourly-level stop reference
}

/**
 * Setup 6, part A — Swing Failure Pattern detection on hourly bars: an
 * hourly bar that trades through a prior confirmed swing low/high and
 * closes back on the other side of it ("raided and closed back above/below").
 * Restricted to NY hours 10-15 (the video explicitly excludes pre-9:30
 * setups; hourly bars starting at 10:00 are the first unambiguously
 * post-open candle, since a 9:00 bar straddles the 9:30 open with no
 * minute-level resolution to split it).
 */
export function detectSfps(
  hourlyBars: Bar[],
  opts: { pivotConfirm: number; biasFilter: "none" | "priorDayClose" },
): DetectedSfp[] {
  const pivots = findPivots(hourlyBars, opts.pivotConfirm);
  const out: DetectedSfp[] = [];

  // prior NY-day's closing price, for the optional bias filter
  const priorDayClose: (number | undefined)[] = [];
  {
    let lastClose: number | undefined;
    let curDay = "";
    for (let i = 0; i < hourlyBars.length; i++) {
      const day = nyDateKey(hourlyBars[i]!.t);
      if (day !== curDay) {
        if (curDay !== "") lastClose = hourlyBars[i - 1]!.c;
        curDay = day;
      }
      priorDayClose.push(lastClose);
    }
  }

  for (let i = opts.pivotConfirm; i < hourlyBars.length; i++) {
    const hour = nyHour(hourlyBars[i]!.t);
    if (hour < 10 || hour > 15) continue;
    const bar = hourlyBars[i]!;

    const priorLows = pivots.filter((p) => p.type === "low" && p.barIndex < i);
    const priorHighs = pivots.filter((p) => p.type === "high" && p.barIndex < i);
    const nearestLow = priorLows.length > 0 ? priorLows[priorLows.length - 1] : undefined;
    const nearestHigh = priorHighs.length > 0 ? priorHighs[priorHighs.length - 1] : undefined;

    const bullishOk = opts.biasFilter === "none" || (priorDayClose[i] !== undefined && bar.c > priorDayClose[i]!);
    const bearishOk = opts.biasFilter === "none" || (priorDayClose[i] !== undefined && bar.c < priorDayClose[i]!);

    if (bullishOk && nearestLow && bar.l < nearestLow.price && bar.c > nearestLow.price) {
      out.push({ hourlyBarIndex: i, direction: "long", swingLevel: nearestLow.price, stopLevel: bar.l });
    } else if (bearishOk && nearestHigh && bar.h > nearestHigh.price && bar.c < nearestHigh.price) {
      out.push({ hourlyBarIndex: i, direction: "short", swingLevel: nearestHigh.price, stopLevel: bar.h });
    }
  }

  return out;
}

/**
 * Setup 6, part B — drops to 5-minute bars after each hourly SFP and looks
 * for the first fair value gap in the trade direction within the next
 * `fvgWindowBars` five-minute bars, entering when price trades into that
 * gap. Stop beyond the FVG's middle candle; fixed target at targetR.
 * Only SFPs whose hourly bar falls within the 5-minute bars' own time
 * range can produce a signal here — the two datasets cover different
 * windows (see report notes).
 */
export function swingFailurePatternEntries(
  fiveMinBars: Bar[],
  sfps: DetectedSfp[],
  hourlyBars: Bar[],
  opts: { fvgWindowBars: number; targetR: number },
): Signal[] {
  const signals: Signal[] = [];
  const fvgs = findFvgs(fiveMinBars);
  const fiveMinTimes = fiveMinBars.map((b) => b.t);

  function firstIndexAtOrAfter(t: number): number {
    let lo = 0;
    let hi = fiveMinTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fiveMinTimes[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  for (const sfp of sfps) {
    const hourlyCloseTime = hourlyBars[sfp.hourlyBarIndex]!.t + 3600;
    const startIdx = firstIndexAtOrAfter(hourlyCloseTime);
    if (startIdx >= fiveMinBars.length) continue; // outside the 5-min data window

    const endIdx = Math.min(fiveMinBars.length - 1, startIdx + opts.fvgWindowBars);
    const candidateFvg = fvgs.find(
      (g) =>
        g.barIndex >= startIdx &&
        g.barIndex <= endIdx &&
        ((sfp.direction === "long" && g.direction === "bullish") ||
          (sfp.direction === "short" && g.direction === "bearish")),
    );
    if (!candidateFvg) continue;

    // candle 2 of the FVG is the displacement candle at candidateFvg.barIndex
    const candle2 = fiveMinBars[candidateFvg.barIndex]!;
    const zoneTop = candidateFvg.top;
    const zoneBottom = candidateFvg.bottom;

    for (let i = candidateFvg.barIndex + 1; i <= endIdx; i++) {
      const bar = fiveMinBars[i]!;
      const touchedZone = bar.l <= zoneTop && bar.h >= zoneBottom;
      if (!touchedZone) continue;

      const entry = bar.c;
      const stop = sfp.direction === "long" ? candle2.l : candle2.h;
      const risk = Math.abs(entry - stop);
      if (risk === 0) break;
      const target = sfp.direction === "long" ? entry + risk * opts.targetR : entry - risk * opts.targetR;

      signals.push({
        barIndex: i,
        direction: sfp.direction,
        entry,
        stop,
        target,
        reason: `SFP @hourly[${sfp.hourlyBarIndex}] (swing ${sfp.swingLevel.toFixed(2)}) + 5m FVG entry`,
      });
      break;
    }
  }

  return signals;
}

/**
 * Setup 7a — Opening Range Breakout with a volume "participation" filter
 * (mechanical approximation of the orderflow-scalping episode's ORB half).
 * The source material's entry filter is real footprint participation
 * (contract counts on the breakout candle); this substitutes the candle's
 * volume versus its trailing volumeLookback-bar average as the closest
 * proxy available from OHLCV bars. Per the source, a wick poke beyond the
 * opening range that closes back inside is explicitly NOT a valid breakout
 * — only a close beyond the range counts. One attempt (long or short,
 * whichever fires first) per session.
 */
export function orbBreakout(
  bars: Bar[],
  opts: { orBars: number; volumeLookback: number; volumeMultiplier: number; targetR: number },
): Signal[] {
  const signals: Signal[] = [];
  let sessionKey = "";
  let orHigh = -Infinity;
  let orLow = Infinity;
  let orBarsSeen = 0;
  let orComplete = false;
  let sessionDone = false;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const key = nyDateKey(bar.t);
    if (key !== sessionKey) {
      sessionKey = key;
      orHigh = -Infinity;
      orLow = Infinity;
      orBarsSeen = 0;
      orComplete = false;
      sessionDone = false;
    }

    if (!orComplete) {
      orHigh = Math.max(orHigh, bar.h);
      orLow = Math.min(orLow, bar.l);
      orBarsSeen++;
      if (orBarsSeen >= opts.orBars) orComplete = true;
      continue;
    }
    if (sessionDone) continue;

    const volStart = Math.max(0, i - opts.volumeLookback);
    let avgVol = 0;
    for (let j = volStart; j < i; j++) avgVol += bars[j]!.v;
    avgVol = i > volStart ? avgVol / (i - volStart) : bar.v;
    const highParticipation = bar.v >= avgVol * opts.volumeMultiplier;
    if (!highParticipation) continue;

    if (bar.c > orHigh) {
      const risk = bar.c - orLow;
      if (risk > 0) {
        signals.push({
          barIndex: i,
          direction: "long",
          entry: bar.c,
          stop: orLow,
          target: bar.c + risk * opts.targetR,
          reason: `ORB long: close ${bar.c.toFixed(2)} > OR high ${orHigh.toFixed(2)}, vol ${bar.v} vs avg ${avgVol.toFixed(0)}`,
        });
        sessionDone = true;
      }
    } else if (bar.c < orLow) {
      const risk = orHigh - bar.c;
      if (risk > 0) {
        signals.push({
          barIndex: i,
          direction: "short",
          entry: bar.c,
          stop: orHigh,
          target: bar.c - risk * opts.targetR,
          reason: `ORB short: close ${bar.c.toFixed(2)} < OR low ${orLow.toFixed(2)}, vol ${bar.v} vs avg ${avgVol.toFixed(0)}`,
        });
        sessionDone = true;
      }
    }
  }

  return signals;
}

/**
 * Setup 7b — "Failed auction" fade at the edges of a rolling volume-profile
 * value area (a market-profile proxy for the source material's order-flow
 * "fair value area"). A bar that pokes outside the value area but closes
 * back inside is read as a failed auction / absorption at the edge; the
 * fade trade targets reversion back toward the middle (point of control) or
 * the opposite edge of the range.
 */
export function valueAreaFade(
  bars: Bar[],
  valueAreas: (ValueArea | null)[],
  opts: { targetMode: "poc" | "oppositeEdge" },
): Signal[] {
  const signals: Signal[] = [];

  for (let i = 0; i < bars.length; i++) {
    const va = valueAreas[i];
    if (!va) continue;
    const bar = bars[i]!;

    const failedAbove = bar.h > va.vah && bar.c <= va.vah;
    const failedBelow = bar.l < va.val && bar.c >= va.val;

    if (failedAbove) {
      const target = opts.targetMode === "poc" ? va.poc : va.val;
      const stop = bar.h;
      if (stop > bar.c && target < bar.c) {
        signals.push({
          barIndex: i,
          direction: "short",
          entry: bar.c,
          stop,
          target,
          reason: `failed auction above VAH ${va.vah.toFixed(2)}, fade to ${opts.targetMode}`,
        });
      }
    } else if (failedBelow) {
      const target = opts.targetMode === "poc" ? va.poc : va.vah;
      const stop = bar.l;
      if (stop < bar.c && target > bar.c) {
        signals.push({
          barIndex: i,
          direction: "long",
          entry: bar.c,
          stop,
          target,
          reason: `failed auction below VAL ${va.val.toFixed(2)}, fade to ${opts.targetMode}`,
        });
      }
    }
  }

  return signals;
}
