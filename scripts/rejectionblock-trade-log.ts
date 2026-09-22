import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithPointsTrail } from "../src/backtest/engine.js";
import { rejectionBlock } from "../src/backtest/strategies.js";
import type { Bar } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

const nq1h = loadBars("data/nq-1h.json");
const rbSignals = rejectionBlock(nq1h, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
const rbTrades = simulateTradesWithPointsTrail(nq1h, rbSignals, { breakevenTriggerPoints: 0, trailStartPoints: 5, trailDistancePoints: 2 });
const curve = buildEquityCurve(nq1h, rbTrades);
const stats = computeStats(rbTrades, curve);

console.log(`Rejection block, 1h NQ, ${rbTrades.length} trades, ${(stats.winRate * 100).toFixed(1)}% win rate, $100 -> $${stats.finalEquity.toFixed(2)}\n`);
console.log("#".padEnd(4) + "Date (UTC)".padEnd(12) + "Dir".padEnd(6) + "Entry".padEnd(11) + "Stop".padEnd(11) + "Exit".padEnd(11) + "R".padEnd(8) + "Outcome".padEnd(9) + "Equity");

const log = rbTrades.map((t, i) => {
  const date = new Date(nq1h[t.barIndex]!.t * 1000).toISOString().slice(0, 10);
  const equity = curve[i + 1]!.equity; // curve[0] is the pre-trade starting point
  return {
    n: i + 1,
    date,
    direction: t.direction,
    entry: t.entry,
    stop: t.stop,
    exitPrice: t.exitPrice,
    rMultiple: t.rMultiple,
    outcome: t.outcome,
    equity,
  };
});

for (const row of log) {
  console.log(
    String(row.n).padEnd(4) +
      row.date.padEnd(12) +
      row.direction.padEnd(6) +
      row.entry.toFixed(2).padEnd(11) +
      row.stop.toFixed(2).padEnd(11) +
      row.exitPrice.toFixed(2).padEnd(11) +
      row.rMultiple.toFixed(2).padEnd(8) +
      row.outcome.padEnd(9) +
      row.equity.toFixed(2),
  );
}

writeFileSync("data/rejectionblock-trade-log.json", JSON.stringify({ generatedAt: new Date().toISOString(), stats, trades: log }, null, 2));
console.log("\nFull trade log written to data/rejectionblock-trade-log.json");
