import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { stdvReversal } from "../src/backtest/strategies.js";
import type { Bar, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(46)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  ` +
      `$100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const nq1h = loadBars("data/nq-1h.json");
  const es1h = loadBars("data/es-1h.json");
  const nq1d = loadBars("data/nq-1d.json");
  const es1d = loadBars("data/es-1d.json");

  console.log(`NQ 5m: ${nq5m.length} bars (~26 days)`);
  console.log(`NQ 1h: ${nq1h.length} bars (~10 months)`);
  console.log(`NQ 1d: ${nq1d.length} bars (~5.2 years)`);
  console.log("");

  const common = {
    pivotConfirm: 3,
    smtTolerance: 0.0005,
    consolidationBars: 4,
    consolidationRangeMultiple: 1.5,
    searchWindowBars: 20,
    targetR: 4,
  };

  const results: StrategyResult[] = [
    runStrategy(
      "5m, raw 50% retrace entry, 25pt max stop",
      nq5m,
      stdvReversal(nq5m, es5m, { ...common, maxStopPoints: 25, entryMode: "raw50" }),
    ),
    runStrategy(
      "5m, rejection-block entry, 25pt max stop",
      nq5m,
      stdvReversal(nq5m, es5m, { ...common, maxStopPoints: 25, entryMode: "rejectionBlock" }),
    ),
    runStrategy(
      "1h, raw 50% retrace entry, no stop cap",
      nq1h,
      stdvReversal(nq1h, es1h, { ...common, maxStopPoints: Infinity, entryMode: "raw50" }),
    ),
    runStrategy(
      "1h, rejection-block entry, no stop cap",
      nq1h,
      stdvReversal(nq1h, es1h, { ...common, maxStopPoints: Infinity, entryMode: "rejectionBlock" }),
    ),
    runStrategy(
      "1d, raw 50% retrace entry, no stop cap",
      nq1d,
      stdvReversal(nq1d, es1d, { ...common, maxStopPoints: Infinity, entryMode: "raw50" }),
    ),
    runStrategy(
      "1d, rejection-block entry, no stop cap",
      nq1d,
      stdvReversal(nq1d, es1d, { ...common, maxStopPoints: Infinity, entryMode: "rejectionBlock" }),
    ),
  ];

  console.log("=== Setup 8 (STDV): SMT -> consolidation -> breakout -> 50% retrace, across timeframes ===");
  results.forEach(summarize);

  console.log("\n=== Ranked by final equity from $100 ===");
  [...results]
    .sort((a, b) => b.stats.finalEquity - a.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${String(i + 1).padStart(2)}. ${r.strategyName} — $100 -> $${r.stats.finalEquity.toFixed(2)}, trades=${r.stats.totalTrades}, totalR=${r.stats.totalR.toFixed(1)}, winRate=${(r.stats.winRate * 100).toFixed(1)}%`,
      ),
    );

  writeFileSync("data/setup8-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nFull results written to data/setup8-results.json");
}

main();
