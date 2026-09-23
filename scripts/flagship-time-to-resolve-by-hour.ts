import { readFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyMinute, nyWeekday } from "../src/backtest/nyTime.js";
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
const result = runStrategy("flagship", nq5m, signals); // unconstrained -- natural time-to-resolve, no deadline

console.log("How long does each trade NATURALLY take to resolve (no deadline constraint), by entry hour?");
console.log("Deadlines for reference: MFF 16:10 NY, LucidFlex 16:45 NY, Apex 16:59 NY\n");

const byHour = new Map<number, number[]>(); // entry hour -> list of minutes-to-resolve
for (const t of result.trades) {
  const entryBar = nq5m[t.barIndex]!;
  const exitBar = nq5m[t.exitBarIndex]!;
  const entryHour = nyHour(entryBar.t);
  const minutesToResolve = (exitBar.t - entryBar.t) / 60;
  if (!byHour.has(entryHour)) byHour.set(entryHour, []);
  byHour.get(entryHour)!.push(minutesToResolve);
}

console.log("Hour  n   minToDeadline(MFF/Lucid/Apex)   medianMinToResolve   minResolve   maxResolve   %resolvedBy1hr");
for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
  const times = byHour.get(h)!.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  const min = times[0]!;
  const max = times[times.length - 1]!;
  const within60 = (times.filter((t) => t <= 60).length / times.length) * 100;

  // minutes from the START of this hour to each deadline (rough, same-day only)
  const toMff = h <= 16 ? (16 - h) * 60 + 10 : NaN;
  const toLucid = h <= 16 ? (16 - h) * 60 + 45 : NaN;
  const toApex = h <= 16 ? (16 - h) * 60 + 59 : NaN;

  console.log(
    `${String(h).padStart(2)}    ${String(times.length).padStart(2)}  ` +
      `${(isNaN(toMff) ? "n/a" : toMff.toString()).padStart(4)}/${(isNaN(toLucid) ? "n/a" : toLucid.toString()).padStart(4)}/${(isNaN(toApex) ? "n/a" : toApex.toString()).padStart(4)} min      ` +
      `${median.toFixed(0).padStart(6)} min          ${min.toFixed(0).padStart(4)} min    ${max.toFixed(0).padStart(6)} min     ${within60.toFixed(0).padStart(3)}%`,
  );
}
