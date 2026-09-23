import type { Bar } from "./types.js";

/**
 * Standard exponential moving average of closes. Seeded with a simple
 * average of the first `period` closes (the common convention), then the
 * usual EMA recursion: ema[i] = close[i] * k + ema[i-1] * (1-k), k = 2/(period+1).
 * NaN for the first period-1 bars (insufficient history).
 */
export function ema(bars: Bar[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  if (bars.length < period) return out;

  const k = 2 / (period + 1);
  let seedSum = 0;
  for (let i = 0; i < period; i++) seedSum += bars[i]!.c;
  let prev = seedSum / period;
  out[period - 1] = prev;

  for (let i = period; i < bars.length; i++) {
    prev = bars[i]!.c * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Choppiness Index: a standard, objective (not strategy-fit) measure of
 * whether a market is trending or ranging over `lookback` bars.
 * 100 * log10( sum(true range, lookback) / (highest high - lowest low) ) / log10(lookback).
 * Higher = choppier/more sideways (true range is being "wasted" relative to
 * net range covered); lower = more trending. Common reference thresholds:
 * >61.8 considered choppy, <38.2 considered trending. NaN for the first
 * lookback-1 bars (insufficient history).
 */
export function choppinessIndex(bars: Bar[], lookback: number): number[] {
  const trueRange = bars.map((bar, i) => {
    if (i === 0) return bar.h - bar.l;
    const prevClose = bars[i - 1]!.c;
    return Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
  });

  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < lookback - 1) {
      out.push(NaN);
      continue;
    }
    const start = i - lookback + 1;
    let sumTR = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = start; j <= i; j++) {
      sumTR += trueRange[j]!;
      hi = Math.max(hi, bars[j]!.h);
      lo = Math.min(lo, bars[j]!.l);
    }
    const range = hi - lo;
    out.push(range > 0 ? (100 * Math.log10(sumTR / range)) / Math.log10(lookback) : 0);
  }
  return out;
}

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
