import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}

function overrideTargetR(signals: Signal[], targetR: number): Signal[] {
  return signals.map((s) => {
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * targetR : s.entry - risk * targetR;
    return { ...s, target };
  });
}

function runCore(label: string, bars: Bar[]): StrategyResult {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const signals = overrideTargetR(merge(meanRev, trend), 5);
  return runStrategy(label, bars, signals);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(28)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

const MARKETS: { label: string; file: string }[] = [
  { label: "NQ (E-mini Nasdaq)", file: "data/nq-5m.json" },
  { label: "MNQ (Micro Nasdaq)", file: "data/mnq-5m.json" },
  { label: "ES (E-mini S&P)", file: "data/es-5m.json" },
  { label: "YM (E-mini Dow)", file: "data/ym-5m.json" },
  { label: "RTY (E-mini Russell)", file: "data/rty-5m.json" },
  { label: "CL (Crude Oil)", file: "data/cl-5m.json" },
  { label: "GC (Gold)", file: "data/gc-5m.json" },
  { label: "6E (Euro FX)", file: "data/6e-5m.json" },
];

function main() {
  console.log("=== Core strategy (5-min, session VWAP mean-rev + trend-continuation, R=5, unfiltered) across markets ===\n");
  const results: StrategyResult[] = [];
  for (const m of MARKETS) {
    const bars = loadBars(m.file);
    const result = runCore(m.label, bars);
    summarize(result);
    results.push(result);
  }

  console.log("\n=== Ranked by final equity from $100 ===");
  [...results]
    .sort((a, b) => b.stats.finalEquity - a.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${i + 1}. ${r.strategyName} — $100 -> $${r.stats.finalEquity.toFixed(2)}, trades=${r.stats.totalTrades}, winRate=${(r.stats.winRate * 100).toFixed(1)}%, totalR=${r.stats.totalR.toFixed(1)}`,
      ),
    );

  writeFileSync("data/cross-market-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nFull results written to data/cross-market-results.json");
}

main();
