import { readFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour } from "../src/backtest/nyTime.js";
import { buildFlagshipSignals } from "../src/backtest/strategies.js";
import type { Bar } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const signals = buildFlagshipSignals(nq5m, vwap);
const trades = simulateTradesWithSessionDeadline(nq5m, signals, { deadlineHour: 16, deadlineMinute: 45 });

console.log(`Full dataset: ${trades.length} trades, ${nq5m.length} bars\n`);

console.log("--- Full-history breakdown by hour (NY), now with much more data ---");
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
  console.log(`${String(h).padStart(2, "0")}:xx NY -- ${String(subset.length).padStart(3)} trades, ${wins} win(s) (${((wins / subset.length) * 100).toFixed(1)}%), totalR=${totalR.toFixed(1).padStart(7)}, avgR=${avgR.toFixed(2).padStart(6)}`);
}

console.log("\n--- Hour 7 specifically, trade-by-trade across all history ---");
const hour7 = trades.filter((t) => nyHour(nq5m[t.barIndex]!.t) === 7);
for (const t of hour7) {
  const day = nyDateKey(nq5m[t.barIndex]!.t);
  console.log(`  ${day}  ${t.direction.padEnd(5)}  rMultiple=${t.rMultiple.toFixed(1)}  ${t.outcome}`);
}

console.log("\n--- Win rate over time: split into 4 quarters chronologically ---");
const q = Math.floor(trades.length / 4);
for (let i = 0; i < 4; i++) {
  const slice = trades.slice(i * q, i === 3 ? trades.length : (i + 1) * q);
  const wins = slice.filter((t) => t.rMultiple > 0).length;
  const totalR = slice.reduce((s, t) => s + t.rMultiple, 0);
  const firstDay = nyDateKey(nq5m[slice[0]!.barIndex]!.t);
  const lastDay = nyDateKey(nq5m[slice[slice.length - 1]!.barIndex]!.t);
  console.log(`Q${i + 1} (${firstDay} to ${lastDay}): ${slice.length} trades, ${wins} wins (${((wins / slice.length) * 100).toFixed(1)}%), totalR=${totalR.toFixed(1)}, avgR=${(totalR / slice.length).toFixed(2)}`);
}

console.log("\n--- Win rate by calendar week ---");
const byWeek = new Map<string, typeof trades>();
function weekLabel(dateKey: string): string {
  const d = new Date(dateKey + "T12:00:00Z");
  const dow = d.getUTCDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}
for (const t of trades) {
  const wk = weekLabel(nyDateKey(nq5m[t.barIndex]!.t));
  if (!byWeek.has(wk)) byWeek.set(wk, []);
  byWeek.get(wk)!.push(t);
}
for (const [wk, subset] of [...byWeek.entries()].sort()) {
  const wins = subset.filter((t) => t.rMultiple > 0).length;
  const totalR = subset.reduce((s, t) => s + t.rMultiple, 0);
  console.log(`Week of ${wk}: ${subset.length} trades, ${wins} wins (${((wins / subset.length) * 100).toFixed(1)}%), totalR=${totalR.toFixed(1)}`);
}
