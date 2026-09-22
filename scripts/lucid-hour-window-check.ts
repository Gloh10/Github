import { readFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyMinute, nyWeekday } from "../src/backtest/nyTime.js";
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
const result = runStrategy("flagship", nq5m, signals);

console.log("LucidFlex hard rule: flat by 4:45pm ET, market closed until 6:00pm ET (16:45-18:00 NY = a mandatory flat window).");
console.log("Checking every trade for whether it was STILL OPEN when 4:45pm NY hit, and whether it crossed into/past that window.\n");

let anyAtRisk = false;
for (const t of result.trades) {
  const entryBar = nq5m[t.barIndex]!;
  const exitBar = nq5m[t.exitBarIndex]!;
  const entryHour = nyHour(entryBar.t);
  const entryMinute = nyMinute(entryBar.t);
  const entryDate = nyDateKey(entryBar.t);
  const exitDate = nyDateKey(exitBar.t);
  const exitHour = nyHour(exitBar.t);
  const exitMinute = nyMinute(exitBar.t);
  const barsHeld = t.exitBarIndex - t.barIndex;

  // Flag any trade whose entry is in the 16:00-16:44 window (could still be open past 16:45)
  // or that remained open into/past the 16:45-18:00 NY flat window on the SAME calendar day.
  const enteredLateHour16 = entryHour === 16;
  const heldPast445 = entryDate === exitDate && (exitHour > 16 || (exitHour === 16 && exitMinute >= 45)) && exitHour < 18 + 1;
  const spansMultipleDays = entryDate !== exitDate;

  if (enteredLateHour16 || heldPast445 || (spansMultipleDays && entryHour >= 15)) {
    anyAtRisk = true;
    console.log(
      `Trade @ bar ${t.barIndex} (${entryDate} ${String(entryHour).padStart(2, "0")}:${String(entryMinute).padStart(2, "0")} NY entry) -> ` +
        `exit @ bar ${t.exitBarIndex} (${exitDate} ${String(exitHour).padStart(2, "0")}:${String(exitMinute).padStart(2, "0")} NY), ` +
        `${barsHeld} bars held (${barsHeld * 5} min), outcome=${t.outcome}, R=${t.rMultiple.toFixed(2)} -- FLAG: entered in hour 16, check against 4:45pm flat deadline`,
    );
  }
}

if (!anyAtRisk) {
  console.log("No trades found that entered in hour 16 or held across the 4:45pm-6pm NY window.");
}

console.log("\n-- Detail: every hour-16 entry, minute-level --");
for (const t of result.trades) {
  const entryBar = nq5m[t.barIndex]!;
  if (nyHour(entryBar.t) !== 16) continue;
  const exitBar = nq5m[t.exitBarIndex]!;
  const entryMinute = nyMinute(entryBar.t);
  const barsHeld = t.exitBarIndex - t.barIndex;
  const minutesToFlatDeadline = (45 - entryMinute) - 5; // minutes remaining after this bar closes before 16:45
  console.log(
    `Entry ${nyDateKey(entryBar.t)} 16:${String(entryMinute).padStart(2, "0")} NY, held ${barsHeld} bars (${barsHeld * 5} min) until exit ` +
      `${nyDateKey(exitBar.t)} ${String(nyHour(exitBar.t)).padStart(2, "0")}:${String(nyMinute(exitBar.t)).padStart(2, "0")} NY -- ` +
      `only ~${minutesToFlatDeadline} min of room before the 4:45pm flat deadline on entry bar's own day, outcome=${t.outcome}`,
  );
}
