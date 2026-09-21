import { isBearishEngulfing, isBullishEngulfing, isHammer, isShootingStar } from "./candlePatterns.js";
import type { VwapPoint } from "./indicators.js";
import type { Bar, Signal } from "./types.js";

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
