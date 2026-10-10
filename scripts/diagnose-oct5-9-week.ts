import { readFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { buildFlagshipSignals } from "../src/backtest/strategies.js";
import type { Bar } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const signals = buildFlagshipSignals(nq5m, vwap);
const trades = simulateTradesWithSessionDeadline(nq5m, signals, { deadlineHour: 16, deadlineMinute: 45 });

const weekTrades = trades.filter((t) => {
  const day = nyDateKey(nq5m[t.barIndex]!.t);
  return day >= "2026-10-05" && day <= "2026-10-09";
});

console.log(`This week's ${weekTrades.length} trades, full detail:\n`);
for (const t of weekTrades) {
  const bar = nq5m[t.barIndex]!;
  const day = nyDateKey(bar.t);
  const hour = nyHour(bar.t);
  const dow = nyWeekday(bar.t);
  const dowName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
  const exitBar = nq5m[t.exitBarIndex]!;
  const exitDay = nyDateKey(exitBar.t);
  const exitHour = nyHour(exitBar.t);
  const riskPoints = Math.abs(t.entry - t.stop);
  const dollars = t.rMultiple * riskPoints * 20;
  console.log(`${day} (${dowName}) ${String(hour).padStart(2, "0")}:xx NY  ${t.direction.padEnd(5)}  entry=${t.entry.toFixed(2)}  stop=${t.stop.toFixed(2)} (risk=${riskPoints.toFixed(2)}pt)  target=${t.target.toFixed(2)}  rMultiple=${t.rMultiple.toFixed(1).padStart(5)}  $${dollars.toFixed(0).padStart(6)}  exit@${exitDay} ${String(exitHour).padStart(2, "0")}:xx (${t.outcome})`);
  console.log(`   reason: ${t.reason}`);
}

console.log("\n--- Breakdown by hour (NY) ---");
const byHour = new Map<number, typeof weekTrades>();
for (const t of weekTrades) {
  const h = nyHour(nq5m[t.barIndex]!.t);
  if (!byHour.has(h)) byHour.set(h, []);
  byHour.get(h)!.push(t);
}
for (const [h, subset] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  console.log(`${String(h).padStart(2, "0")}:xx NY -- ${subset.length} trade(s), totalR=${totalR.toFixed(1)}`);
}

console.log("\n--- Breakdown by direction ---");
for (const dir of ["long", "short"] as const) {
  const subset = weekTrades.filter((t) => t.direction === dir);
  const wins = subset.filter((t) => t.rMultiple > 0).length;
  console.log(`${dir}: ${subset.length} trades, ${wins} win(s), totalR=${subset.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)}`);
}

// Check: after a win, what's the next trade's risk size vs the losing streak's risk sizes?
console.log("\n--- Risk size (stop distance in points) per trade, in sequence ---");
for (const t of weekTrades) {
  const riskPoints = Math.abs(t.entry - t.stop);
  console.log(`  risk=${riskPoints.toFixed(2)}pt  rMultiple=${t.rMultiple.toFixed(1)}  ${t.outcome}`);
}

// Compare Wed/Thu's losing trades against this exact signal type's full-history win rate
console.log("\n--- Full-history win rate for mean-reversion signals specifically ---");
const allMeanRev = trades.filter((t) => t.reason.includes("mean-reversion"));
const wedThuTrades = weekTrades.filter((t) => {
  const day = nyDateKey(nq5m[t.barIndex]!.t);
  return day === "2026-10-07" || day === "2026-10-08";
});
console.log(`All-time mean-reversion: ${allMeanRev.length} trades, ${allMeanRev.filter((t) => t.rMultiple > 0).length} wins (${((allMeanRev.filter((t) => t.rMultiple > 0).length / allMeanRev.length) * 100).toFixed(1)}%)`);
console.log(`Wed+Thu this week: ${wedThuTrades.length} trades, ${wedThuTrades.filter((t) => t.rMultiple > 0).length} wins`);

// Market context: was this a low-volatility/choppy stretch?
function trueRange(bars: Bar[], i: number): number {
  if (i === 0) return bars[i]!.h - bars[i]!.l;
  return Math.max(bars[i]!.h - bars[i]!.l, Math.abs(bars[i]!.h - bars[i - 1]!.c), Math.abs(bars[i]!.l - bars[i - 1]!.c));
}
let sumWed = 0, nWed = 0, sumRest = 0, nRest = 0;
for (let i = 1; i < nq5m.length; i++) {
  const day = nyDateKey(nq5m[i]!.t);
  if (day === "2026-10-07" || day === "2026-10-08") { sumWed += trueRange(nq5m, i); nWed++; }
  else if (day >= "2026-09-01" && day < "2026-10-07") { sumRest += trueRange(nq5m, i); nRest++; }
}
console.log(`\nAvg 5-min true range Wed+Thu (10/7-10/8): ${(sumWed / nWed).toFixed(2)} pts`);
console.log(`Avg 5-min true range Sept baseline: ${(sumRest / nRest).toFixed(2)} pts`);
