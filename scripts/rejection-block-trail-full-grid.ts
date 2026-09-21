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
    `${result.strategyName.padEnd(30)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

// Best config found: immediate breakeven, tight (2pt) trail after 5pt profit, no fixed target.
const OPTS = { breakevenTriggerPoints: 0, trailStartPoints: 5, trailDistancePoints: 2 };

function runBest(name: string, bars: Bar[]): StrategyResult {
  const signals = rejectionBlock(bars, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
  const trades = simulateTradesWithPointsTrail(bars, signals, OPTS);
  const curve = buildEquityCurve(bars, trades);
  const stats = computeStats(trades, curve);
  return { strategyName: name, trades, equityCurve: curve, stats };
}

function main() {
  console.log("Config: rejection block alone (no FVG confluence), breakeven on any favorable tick, trail 2pt behind price once 5pt+ in profit, no fixed target.\n");

  console.log("=".repeat(78));
  console.log("PART 1: NQ across all 4 timeframes");
  console.log("=".repeat(78));
  const nqTimeframes = [
    { label: "NQ 5-min", file: "data/nq-5m.json" },
    { label: "NQ 15-min", file: "data/nq-15m.json" },
    { label: "NQ 1-hour", file: "data/nq-1h.json" },
    { label: "NQ 1-day", file: "data/nq-1d.json" },
  ];
  const nqResults = nqTimeframes.map((tf) => runBest(tf.label, loadBars(tf.file)));
  nqResults.forEach(summarize);

  console.log("\n" + "=".repeat(78));
  console.log("PART 2: ES across the 3 timeframes with cached data (no 15-min ES fetched)");
  console.log("=".repeat(78));
  const esTimeframes = [
    { label: "ES 5-min", file: "data/es-5m.json" },
    { label: "ES 1-hour", file: "data/es-1h.json" },
    { label: "ES 1-day", file: "data/es-1d.json" },
  ];
  const esResults = esTimeframes.map((tf) => runBest(tf.label, loadBars(tf.file)));
  esResults.forEach(summarize);

  console.log("\n" + "=".repeat(78));
  console.log("PART 3: Cross-market, 5-min (all 8 markets with cached data)");
  console.log("=".repeat(78));
  const markets = [
    { label: "NQ (E-mini Nasdaq)", file: "data/nq-5m.json" },
    { label: "MNQ (Micro Nasdaq)", file: "data/mnq-5m.json" },
    { label: "ES (E-mini S&P)", file: "data/es-5m.json" },
    { label: "YM (E-mini Dow)", file: "data/ym-5m.json" },
    { label: "RTY (E-mini Russell)", file: "data/rty-5m.json" },
    { label: "CL (Crude Oil)", file: "data/cl-5m.json" },
    { label: "GC (Gold)", file: "data/gc-5m.json" },
    { label: "6E (Euro FX)", file: "data/6e-5m.json" },
  ];
  const marketResults = markets.map((m) => runBest(m.label, loadBars(m.file)));
  marketResults.forEach(summarize);

  console.log("\n=== Ranked: NQ timeframes ===");
  [...nqResults].sort((a, b) => b.stats.finalEquity - a.stats.finalEquity).forEach((r, i) => console.log(`${i + 1}. ${r.strategyName} — $${r.stats.finalEquity.toFixed(2)}, winRate=${(r.stats.winRate * 100).toFixed(1)}%, trades=${r.stats.totalTrades}`));

  console.log("\n=== Ranked: ES timeframes ===");
  [...esResults].sort((a, b) => b.stats.finalEquity - a.stats.finalEquity).forEach((r, i) => console.log(`${i + 1}. ${r.strategyName} — $${r.stats.finalEquity.toFixed(2)}, winRate=${(r.stats.winRate * 100).toFixed(1)}%, trades=${r.stats.totalTrades}`));

  console.log("\n=== Ranked: cross-market (5-min) ===");
  [...marketResults].sort((a, b) => b.stats.finalEquity - a.stats.finalEquity).forEach((r, i) => console.log(`${i + 1}. ${r.strategyName} — $${r.stats.finalEquity.toFixed(2)}, winRate=${(r.stats.winRate * 100).toFixed(1)}%, trades=${r.stats.totalTrades}`));

  writeFileSync(
    "data/rejection-block-trail-full-grid-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: OPTS,
        nqTimeframes: nqResults.map((r) => ({ label: r.strategyName, stats: r.stats })),
        esTimeframes: esResults.map((r) => ({ label: r.strategyName, stats: r.stats })),
        crossMarket: marketResults.map((r) => ({ label: r.strategyName, stats: r.stats })),
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/rejection-block-trail-full-grid-results.json");
}

main();
