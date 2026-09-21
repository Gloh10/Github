import type { Bar } from "./types.js";

export interface VwapPoint {
  vwap: number;
  upperBand1: number;
  lowerBand1: number;
  upperBand2: number;
  lowerBand2: number;
}

function typicalPrice(bar: Bar): number {
  return (bar.h + bar.l + bar.c) / 3;
}

/**
 * Session-anchored VWAP: resets at the start of each UTC calendar day.
 * Used for the 5-minute intraday tests, matching the "session" anchor
 * described in both source videos.
 */
export function sessionVwap(bars: Bar[]): VwapPoint[] {
  const out: VwapPoint[] = [];
  let cumPV = 0;
  let cumV = 0;
  let cumPV2 = 0; // for variance: sum((tp - vwap)^2 * v), approximated incrementally
  let currentDay = "";

  for (const bar of bars) {
    const day = new Date(bar.t * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumV = 0;
      cumPV2 = 0;
    }
    const tp = typicalPrice(bar);
    cumPV += tp * bar.v;
    cumV += bar.v;
    const vwap = cumV > 0 ? cumPV / cumV : tp;

    cumPV2 += bar.v * (tp - vwap) ** 2;
    const variance = cumV > 0 ? cumPV2 / cumV : 0;
    const stdDev = Math.sqrt(Math.max(variance, 0));

    out.push({
      vwap,
      upperBand1: vwap + stdDev,
      lowerBand1: vwap - stdDev,
      upperBand2: vwap + 2 * stdDev,
      lowerBand2: vwap - 2 * stdDev,
    });
  }
  return out;
}

/**
 * Rolling VWAP over a fixed lookback window of bars — the daily-timeframe
 * analog used for the 5-year test, since a session VWAP has no meaning on
 * daily bars. This mirrors the "rolling VWAP" variant covered in the
 * educational video (a VWAP that never resets, computed over N periods).
 */
export function rollingVwap(bars: Bar[], lookback: number): VwapPoint[] {
  const out: VwapPoint[] = [];
  const tps = bars.map(typicalPrice);

  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - lookback + 1);
    let cumPV = 0;
    let cumV = 0;
    for (let j = start; j <= i; j++) {
      cumPV += tps[j]! * bars[j]!.v;
      cumV += bars[j]!.v;
    }
    const vwap = cumV > 0 ? cumPV / cumV : tps[i]!;

    let cumPV2 = 0;
    for (let j = start; j <= i; j++) {
      cumPV2 += bars[j]!.v * (tps[j]! - vwap) ** 2;
    }
    const variance = cumV > 0 ? cumPV2 / cumV : 0;
    const stdDev = Math.sqrt(Math.max(variance, 0));

    out.push({
      vwap,
      upperBand1: vwap + stdDev,
      lowerBand1: vwap - stdDev,
      upperBand2: vwap + 2 * stdDev,
      lowerBand2: vwap - 2 * stdDev,
    });
  }
  return out;
}
