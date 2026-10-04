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

const days = trades.filter((t) => {
  const day = nyDateKey(nq5m[t.barIndex]!.t);
  return day === "2026-09-28" || day === "2026-09-29";
});

for (const t of days) {
  const bar = nq5m[t.barIndex]!;
  const day = nyDateKey(bar.t);
  const hour = nyHour(bar.t);
  const exitBar = nq5m[t.exitBarIndex]!;
  const exitDay = nyDateKey(exitBar.t);
  const exitHour = nyHour(exitBar.t);
  const riskPoints = Math.abs(t.entry - t.stop);
  const dollars = t.rMultiple * riskPoints * 20;
  console.log(`${day} ${String(hour).padStart(2, "0")}:xx NY  ${t.direction.padEnd(5)}  entry=${t.entry.toFixed(2)}  stop=${t.stop.toFixed(2)}  target=${t.target.toFixed(2)}  rMultiple=${t.rMultiple.toFixed(1).padStart(5)}  $${dollars.toFixed(0).padStart(6)}  exit@${exitDay} ${String(exitHour).padStart(2, "0")}:xx (${t.outcome})`);
  console.log(`   reason: ${t.reason}`);
}
