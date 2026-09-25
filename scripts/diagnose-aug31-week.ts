import { readFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
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

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const signals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const trades = simulateTradesWithSessionDeadline(nq5m, signals, { deadlineHour: 16, deadlineMinute: 45 });

const weekTrades = trades.filter((t) => {
  const day = nyDateKey(nq5m[t.barIndex]!.t);
  return day >= "2026-08-31" && day <= "2026-09-06";
});
console.log(`Week of 2026-08-31, all ${weekTrades.length} trades under the OLD (mean-rev + trend) flagship:\n`);
for (const t of weekTrades) {
  const bar = nq5m[t.barIndex]!;
  const day = nyDateKey(bar.t);
  const type = t.reason.includes("mean-reversion") ? "MEAN-REV" : "TREND";
  console.log(`${day}  ${t.direction.padEnd(5)} ${type.padEnd(9)} rMultiple=${t.rMultiple.toFixed(1).padStart(5)}  reason="${t.reason}"`);
}
const trendOnly = weekTrades.filter((t) => t.reason.includes("trend continuation"));
console.log(`\nTrend-only this week: ${trendOnly.length} trades, totalR=${trendOnly.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)}`);
