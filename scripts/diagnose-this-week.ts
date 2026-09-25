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

const cutoff = "2026-09-22";
const thisWeek = trades.filter((t) => nyDateKey(nq5m[t.barIndex]!.t) >= cutoff);

console.log(`This week's ${thisWeek.length} trades, full detail:\n`);
for (const t of thisWeek) {
  const bar = nq5m[t.barIndex]!;
  const day = nyDateKey(bar.t);
  const hour = nyHour(bar.t);
  const dow = nyWeekday(bar.t);
  const dowName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
  const type = t.reason.includes("mean-reversion") ? "MEAN-REV" : t.reason.includes("trend continuation") ? "TREND" : "OTHER";
  console.log(`${day} (${dowName}) ${String(hour).padStart(2, "0")}:xx NY  ${t.direction.padEnd(5)} ${type.padEnd(9)} rMultiple=${t.rMultiple.toFixed(1).padStart(5)}  entry=${t.entry.toFixed(2)}  reason="${t.reason}"`);
}

console.log("\n--- Breakdown by type ---");
for (const type of ["mean-reversion", "trend continuation"]) {
  const subset = thisWeek.filter((t) => t.reason.includes(type));
  const wins = subset.filter((t) => t.rMultiple > 0).length;
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  console.log(`${type}: ${subset.length} trades, ${wins} win(s), totalR=${totalR.toFixed(1)}`);
}
console.log("\n--- Breakdown by direction ---");
for (const dir of ["long", "short"] as const) {
  const subset = thisWeek.filter((t) => t.direction === dir);
  const wins = subset.filter((t) => t.rMultiple > 0).length;
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  console.log(`${dir}: ${subset.length} trades, ${wins} win(s), totalR=${totalR.toFixed(1)}`);
}
console.log("\n--- Breakdown by hour (NY) ---");
const byHour = new Map<number, typeof thisWeek>();
for (const t of thisWeek) {
  const h = nyHour(nq5m[t.barIndex]!.t);
  if (!byHour.has(h)) byHour.set(h, []);
  byHour.get(h)!.push(t);
}
for (const [h, subset] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  console.log(`${String(h).padStart(2, "0")}:xx NY -- ${subset.length} trade(s), totalR=${totalR.toFixed(1)}`);
}

// Context: what did price/volatility look like this week vs the rest of the dataset?
console.log("\n--- Market context this week vs full dataset ---");
function trueRange(bars: Bar[], i: number): number {
  if (i === 0) return bars[i]!.h - bars[i]!.l;
  return Math.max(bars[i]!.h - bars[i]!.l, Math.abs(bars[i]!.h - bars[i - 1]!.c), Math.abs(bars[i]!.l - bars[i - 1]!.c));
}
function avgTrueRange(bars: Bar[], fromDate: string | null): number {
  let sum = 0, n = 0;
  for (let i = 1; i < bars.length; i++) {
    const day = nyDateKey(bars[i]!.t);
    if (fromDate && day < fromDate) continue;
    if (fromDate === null && day >= cutoff) continue;
    sum += trueRange(bars, i);
    n++;
  }
  return sum / n;
}
console.log(`Avg 5-min true range, full dataset before this week: ${avgTrueRange(nq5m, null).toFixed(2)} pts`);
console.log(`Avg 5-min true range, this week only: ${avgTrueRange(nq5m, cutoff).toFixed(2)} pts`);
