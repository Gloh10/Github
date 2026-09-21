import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { rejectionBlock } from "../src/backtest/strategies.js";
import type { Bar, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(46)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function main() {
  const timeframes: { label: string; file: string }[] = [
    { label: "5-min", file: "data/nq-5m.json" },
    { label: "15-min", file: "data/nq-15m.json" },
    { label: "1-hour", file: "data/nq-1h.json" },
    { label: "1-day", file: "data/nq-1d.json" },
  ];

  const targetRValues = [2, 3];
  const results: { timeframe: string; alone: boolean; targetR: number; result: StrategyResult }[] = [];

  for (const tf of timeframes) {
    const bars = loadBars(tf.file);
    console.log(`\n=== ${tf.label} (${bars.length} bars) ===`);
    for (const targetR of targetRValues) {
      const alone = rejectionBlock(bars, { pivotConfirm: 3, targetR, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
      const paired = rejectionBlock(bars, { pivotConfirm: 3, targetR, requireFvgConfluence: true, fvgToleranceFraction: 0.0015 });

      const aloneResult = runStrategy(`${tf.label}, alone, R=${targetR}`, bars, alone);
      const pairedResult = runStrategy(`${tf.label}, +FVG confluence, R=${targetR}`, bars, paired);
      summarize(aloneResult);
      summarize(pairedResult);

      results.push({ timeframe: tf.label, alone: true, targetR, result: aloneResult });
      results.push({ timeframe: tf.label, alone: false, targetR, result: pairedResult });
    }
  }

  console.log("\n=== Ranked by final equity from $100 (all timeframe x alone/paired x R combos) ===");
  [...results]
    .sort((a, b) => b.result.stats.finalEquity - a.result.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${String(i + 1).padStart(2)}. ${r.result.strategyName} — $100 -> $${r.result.stats.finalEquity.toFixed(2)}, ` +
          `trades=${r.result.stats.totalTrades}, winRate=${(r.result.stats.winRate * 100).toFixed(1)}%, totalR=${r.result.stats.totalR.toFixed(1)}`,
      ),
    );

  console.log("\n=== Alone vs. paired-with-FVG, averaged across timeframes and R values ===");
  for (const alone of [true, false]) {
    const subset = results.filter((r) => r.alone === alone);
    const avgFinalEquity = subset.reduce((s, r) => s + r.result.stats.finalEquity, 0) / subset.length;
    const avgWinRate = subset.reduce((s, r) => s + r.result.stats.winRate, 0) / subset.length;
    const totalTrades = subset.reduce((s, r) => s + r.result.stats.totalTrades, 0);
    console.log(
      `${alone ? "Alone (no confluence)" : "Paired with FVG confluence"}: avg finalEquity=$${avgFinalEquity.toFixed(2)}, ` +
        `avg winRate=${(avgWinRate * 100).toFixed(1)}%, total trades across all combos=${totalTrades}`,
    );
  }

  writeFileSync(
    "data/setup10-results.json",
    JSON.stringify(
      { generatedAt: new Date().toISOString(), results: results.map((r) => ({ timeframe: r.timeframe, alone: r.alone, targetR: r.targetR, stats: r.result.stats })) },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/setup10-results.json");
}

main();
