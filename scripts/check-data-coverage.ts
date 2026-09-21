import { readFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}
const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];
function dayHourFilter(bars: Bar[], signals: Signal[]): Signal[] {
  return signals.filter((s) => {
    const bar = bars[s.barIndex]!;
    const hour = nyHour(bar.t);
    const weekday = nyWeekday(bar.t);
    if (EXCLUDED_HOURS.includes(hour)) return false;
    if (weekday === 0) return false;
    if (weekday === 1 && EXCLUDED_MONDAY_HOURS.includes(hour)) return false;
    return true;
  });
}
function overrideTargetR(signals: Signal[], targetR: number): Signal[] {
  return signals.map((s) => {
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * targetR : s.entry - risk * targetR;
    return { ...s, target };
  });
}

const bars = loadBars("data/nq-5m.json");
const vwap = sessionVwap(bars);
const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const signals = overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);
const result = runStrategy("best", bars, signals);

const dayKeys = new Set(result.trades.map((t) => nyDateKey(bars[t.barIndex]!.t)));
const startBalance = 100;
const finalBalance = startBalance * result.trades.reduce((acc, t) => acc * (1 + t.rMultiple * 0.02), 1); // rough, just for a sanity read

console.log(`Total bars: ${bars.length}`);
console.log(`Trades: ${result.trades.length}`);
console.log(`Distinct NY trading days with trades: ${dayKeys.size}`);
console.log([...dayKeys].sort());
console.log(`Win rate: ${(result.stats.winRate * 100).toFixed(1)}%`);
