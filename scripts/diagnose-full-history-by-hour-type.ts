import { readFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
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

console.log(`Full dataset: ${trades.length} trades\n`);

console.log("--- Full-history breakdown by hour (NY) ---");
const byHour = new Map<number, typeof trades>();
for (const t of trades) {
  const h = nyHour(nq5m[t.barIndex]!.t);
  if (!byHour.has(h)) byHour.set(h, []);
  byHour.get(h)!.push(t);
}
for (const [h, subset] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
  const wins = subset.filter((t) => t.rMultiple > 0).length;
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  const avgR = totalR / subset.length;
  console.log(`${String(h).padStart(2, "0")}:xx NY -- ${String(subset.length).padStart(2)} trades, ${wins} win(s), totalR=${totalR.toFixed(1).padStart(6)}, avgR=${avgR.toFixed(2).padStart(6)}`);
}

console.log("\n--- Full-history breakdown by type ---");
for (const type of ["mean-reversion", "trend continuation"]) {
  const subset = trades.filter((t) => t.reason.includes(type));
  const wins = subset.filter((t) => t.rMultiple > 0).length;
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  console.log(`${type}: ${subset.length} trades, ${wins} win(s) (${((wins / subset.length) * 100).toFixed(1)}%), totalR=${totalR.toFixed(1)}, avgR=${(totalR / subset.length).toFixed(2)}`);
}

console.log("\n--- Split-period check: hours 7 and 20 specifically ---");
const mid = Math.floor(nq5m.length / 2);
for (const h of [7, 20]) {
  const subset = trades.filter((t) => nyHour(nq5m[t.barIndex]!.t) === h);
  const h1 = subset.filter((t) => t.barIndex < mid);
  const h2 = subset.filter((t) => t.barIndex >= mid);
  console.log(`Hour ${h}: full totalR=${subset.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)} (n=${subset.length})  |  H1 totalR=${h1.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)} (n=${h1.length})  |  H2 totalR=${h2.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)} (n=${h2.length})`);
}

console.log("\n--- Split-period check: trend-continuation specifically ---");
const trendTrades = trades.filter((t) => t.reason.includes("trend continuation"));
const trendH1 = trendTrades.filter((t) => t.barIndex < mid);
const trendH2 = trendTrades.filter((t) => t.barIndex >= mid);
console.log(`Trend: full totalR=${trendTrades.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)} (n=${trendTrades.length})  |  H1 totalR=${trendH1.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)} (n=${trendH1.length})  |  H2 totalR=${trendH2.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)} (n=${trendH2.length})`);
