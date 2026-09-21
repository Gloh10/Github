import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithPointsTrail } from "../src/backtest/engine.js";
import { rejectionBlock } from "../src/backtest/strategies.js";
import type { Bar, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(56)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

const BREAKEVEN_TRIGGER_POINTS = [0, 1]; // 0 = "any" favorable tick at all
const TRAIL_START_POINTS = 5; // as specified
const TRAIL_DISTANCE_POINTS = [2, 3, 5]; // "tightly" -- a few candidate widths

function main() {
  const timeframes: { label: string; file: string }[] = [
    { label: "5-min", file: "data/nq-5m.json" },
    { label: "15-min", file: "data/nq-15m.json" },
    { label: "1-hour", file: "data/nq-1h.json" },
    { label: "1-day", file: "data/nq-1d.json" },
  ];

  const results: { timeframe: string; alone: boolean; be: number; trail: number; result: StrategyResult }[] = [];

  for (const tf of timeframes) {
    const bars = loadBars(tf.file);
    console.log(`\n=== ${tf.label} (${bars.length} bars) ===`);
    for (const alone of [true, false]) {
      const signals = rejectionBlock(bars, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: !alone, fvgToleranceFraction: 0.0015 });
      for (const be of BREAKEVEN_TRIGGER_POINTS) {
        for (const trail of TRAIL_DISTANCE_POINTS) {
          const trades = simulateTradesWithPointsTrail(bars, signals, {
            breakevenTriggerPoints: be,
            trailStartPoints: TRAIL_START_POINTS,
            trailDistancePoints: trail,
          });
          const curve = buildEquityCurve(bars, trades);
          const stats = computeStats(trades, curve);
          const label = `${tf.label}, ${alone ? "alone" : "+FVG"}, BE@${be}pt, trail@5pt/${trail}pt`;
          const result: StrategyResult = { strategyName: label, trades, equityCurve: curve, stats };
          summarize(result);
          results.push({ timeframe: tf.label, alone, be, trail, result });
        }
      }
    }
  }

  console.log("\n=== Top 10 by final equity from $100 (all combos) ===");
  [...results]
    .sort((a, b) => b.result.stats.finalEquity - a.result.stats.finalEquity)
    .slice(0, 10)
    .forEach((r, i) => console.log(`${i + 1}. ${r.result.strategyName} — $100 -> $${r.result.stats.finalEquity.toFixed(2)}`));

  // Compare against the original fixed-R version for the same signal sets (no management change).
  console.log("\n=== For reference: best fixed-R result from the earlier Setup 10 run was $100.71 (5-min, +FVG, R=2) ===");

  writeFileSync(
    "data/rejection-block-trail-results.json",
    JSON.stringify(
      { generatedAt: new Date().toISOString(), results: results.map((r) => ({ timeframe: r.timeframe, alone: r.alone, be: r.be, trail: r.trail, stats: r.result.stats })) },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/rejection-block-trail-results.json");
}

main();
