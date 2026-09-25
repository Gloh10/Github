import { readFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey } from "../src/backtest/nyTime.js";
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
  return day >= "2026-08-31" && day <= "2026-09-06";
});
console.log(`Week of 2026-08-31, all ${weekTrades.length} trades under the NEW (mean-rev only) flagship:\n`);
for (const t of weekTrades) {
  const day = nyDateKey(nq5m[t.barIndex]!.t);
  console.log(`${day}  ${t.direction.padEnd(5)} rMultiple=${t.rMultiple.toFixed(1).padStart(5)}  entry=${t.entry.toFixed(2)}  reason="${t.reason}"`);
}
console.log(`\ntotalR this week (NEW): ${weekTrades.reduce((s, t) => s + t.rMultiple, 0).toFixed(1)}`);
