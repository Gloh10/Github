import { readFileSync, writeFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { buildFlagshipSignals, vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const DEADLINE = { deadlineHour: 16, deadlineMinute: 45 };

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
function pnlOf(t: Trade): number {
  const riskPoints = Math.abs(t.entry - t.stop);
  return t.rMultiple * riskPoints * NQ_POINT_VALUE_USD;
}
// ISO-week-ish bucket: NY calendar date's Monday-of-week, as a label.
function weekLabel(dateKey: string): string {
  const d = new Date(dateKey + "T12:00:00Z"); // noon UTC avoids DST edge issues
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);

// Baseline = old flagship (mean-rev + trend), Candidate = new flagship (mean-rev only)
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const baselineSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const candidateSignals = buildFlagshipSignals(nq5m, vwap);

const baselineTrades = simulateTradesWithSessionDeadline(nq5m, baselineSignals, DEADLINE);
const candidateTrades = simulateTradesWithSessionDeadline(nq5m, candidateSignals, DEADLINE);

function bucketByWeek(bars: Bar[], trades: Trade[]): Map<string, Trade[]> {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const day = nyDateKey(bars[t.barIndex]!.t);
    const wk = weekLabel(day);
    if (!map.has(wk)) map.set(wk, []);
    map.get(wk)!.push(t);
  }
  return map;
}

const baselineByWeek = bucketByWeek(nq5m, baselineTrades);
const candidateByWeek = bucketByWeek(nq5m, candidateTrades);
const allWeeks = [...new Set([...baselineByWeek.keys(), ...candidateByWeek.keys()])].sort();

console.log("=".repeat(120));
console.log("Week-by-week comparison: OLD flagship (mean-rev + trend) vs NEW flagship (mean-rev only)");
console.log("=".repeat(120));
console.log(`Full dataset spans ${nq5m.length} bars, week-of-Monday buckets below.\n`);

console.log(
  "Week of".padEnd(12) +
    "| OLD trades  totalR    $      | NEW trades  totalR    $      | NEW better?",
);
console.log("-".repeat(120));

let baselineTotalR = 0, candidateTotalR = 0, baselineTotalUSD = 0, candidateTotalUSD = 0;
const rows: unknown[] = [];
for (const wk of allWeeks) {
  const b = baselineByWeek.get(wk) ?? [];
  const c = candidateByWeek.get(wk) ?? [];
  const bR = b.reduce((s, t) => s + t.rMultiple, 0);
  const cR = c.reduce((s, t) => s + t.rMultiple, 0);
  const bUSD = b.reduce((s, t) => s + pnlOf(t), 0);
  const cUSD = c.reduce((s, t) => s + pnlOf(t), 0);
  baselineTotalR += bR; candidateTotalR += cR; baselineTotalUSD += bUSD; candidateTotalUSD += cUSD;
  const verdict = cUSD > bUSD ? "better" : cUSD < bUSD ? "worse" : "tie";
  console.log(
    `${wk.padEnd(12)}| ${String(b.length).padStart(2)}         ${bR.toFixed(1).padStart(6)}  $${bUSD.toFixed(0).padStart(6)}  | ${String(c.length).padStart(2)}         ${cR.toFixed(1).padStart(6)}  $${cUSD.toFixed(0).padStart(6)}  | ${verdict}`,
  );
  rows.push({ week: wk, oldTrades: b.length, oldTotalR: bR, oldUSD: bUSD, newTrades: c.length, newTotalR: cR, newUSD: cUSD, verdict });
}
console.log("-".repeat(120));
console.log(
  `${"TOTAL".padEnd(12)}| ${String(baselineTrades.length).padStart(2)}         ${baselineTotalR.toFixed(1).padStart(6)}  $${baselineTotalUSD.toFixed(0).padStart(6)}  | ${String(candidateTrades.length).padStart(2)}         ${candidateTotalR.toFixed(1).padStart(6)}  $${candidateTotalUSD.toFixed(0).padStart(6)}  |`,
);

const worseWeeks = rows.filter((r: any) => r.verdict === "worse");
const betterWeeks = rows.filter((r: any) => r.verdict === "better");
console.log(`\nNEW flagship did better in ${betterWeeks.length}/${allWeeks.length} weeks, worse in ${worseWeeks.length}/${allWeeks.length}, tied in ${allWeeks.length - betterWeeks.length - worseWeeks.length}.`);
if (worseWeeks.length > 0) {
  console.log("Weeks where dropping the trend leg would have cost money vs. keeping it:");
  for (const w of worseWeeks as any[]) console.log(`  ${w.week}: OLD $${w.oldUSD.toFixed(0)} vs NEW $${w.newUSD.toFixed(0)} (NEW worse by $${(w.oldUSD - w.newUSD).toFixed(0)})`);
}

writeFileSync("data/week-by-week-baseline-vs-meanrevonly-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
console.log("\nFull results written to data/week-by-week-baseline-vs-meanrevonly-results.json");
