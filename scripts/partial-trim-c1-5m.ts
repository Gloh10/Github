import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithPartialAtR } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour } from "../src/backtest/nyTime.js";
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

const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
function hourFilter(bars: Bar[], signals: Signal[]): Signal[] {
  return signals.filter((s) => !EXCLUDED_HOURS.includes(nyHour(bars[s.barIndex]!.t)));
}

function buildSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const base = overrideTargetR(merge(meanRev, trend), 5);
  return hourFilter(bars, base);
}

function runVariant(name: string, bars: Bar[], trimAtR: number, trimFraction: number): StrategyResult {
  const signals = buildSignals(bars);
  const trades = simulateTradesWithPartialAtR(bars, signals, { trimAtR, trimFraction });
  const curve = buildEquityCurve(bars, trades);
  const stats = computeStats(trades, curve);
  return { strategyName: name, trades, equityCurve: curve, stats };
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
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  console.log("=".repeat(78));
  console.log("Baseline (no trim, no breakeven): hour-filtered 5-min C1, R=5");
  console.log("=".repeat(78));
  const noTrim = runVariant("No trim/breakeven (current best)", nq5m, Infinity, 0);
  summarize(noTrim);

  console.log("\n" + "=".repeat(78));
  console.log("Grid: trim-at-R (2, 2.5, 3, 3.5, 4) x trim-fraction (25%, 33%, 50%, 67%)");
  console.log("=".repeat(78));
  const trimAtRValues = [2, 2.5, 3, 3.5, 4];
  const trimFractions = [0.25, 0.33, 0.5, 0.67];
  const grid: { trimAtR: number; trimFraction: number; result: StrategyResult }[] = [];
  const header = "trimAtR\\frac".padEnd(14) + trimFractions.map((f) => `${(f * 100).toFixed(0)}%`.padStart(10)).join("");
  console.log(header);
  for (const r of trimAtRValues) {
    const row: string[] = [];
    for (const f of trimFractions) {
      const result = runVariant(`trim@${r}R,${f}`, nq5m, r, f);
      grid.push({ trimAtR: r, trimFraction: f, result });
      row.push(`$${result.stats.finalEquity.toFixed(2)}`.padStart(10));
    }
    console.log(String(r).padEnd(14) + row.join(""));
  }
  output.baseline = noTrim;
  output.grid = grid.map((c) => ({ trimAtR: c.trimAtR, trimFraction: c.trimFraction, stats: c.result.stats }));

  const ranked = [...grid].sort((a, b) => b.result.stats.finalEquity - a.result.stats.finalEquity);
  console.log("\n=== Top 5 trim configs by final equity ===");
  ranked.slice(0, 5).forEach((c, i) => {
    console.log(`${i + 1}. trim@${c.trimAtR}R, ${(c.trimFraction * 100).toFixed(0)}% —`);
    summarize(c.result);
  });

  const best = ranked[0]!;
  console.log(`\n=== Validating best config: trim@${best.trimAtR}R, ${(best.trimFraction * 100).toFixed(0)}% ===`);
  const mid = Math.floor(nq5m.length / 2);
  const firstHalf = nq5m.slice(0, mid);
  const secondHalf = nq5m.slice(mid);

  const full = runVariant("Full", nq5m, best.trimAtR, best.trimFraction);
  const h1 = runVariant("First half", firstHalf, best.trimAtR, best.trimFraction);
  const h2 = runVariant("Second half", secondHalf, best.trimAtR, best.trimFraction);
  const oos = runVariant("ES 5-min (OOS)", es5m, best.trimAtR, best.trimFraction);
  [full, h1, h2, oos].forEach(summarize);
  const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
  console.log(bothPositive ? "Split-period verdict: POSITIVE in both halves." : "Split-period verdict: NOT positive in both halves.");

  output.bestConfig = { trimAtR: best.trimAtR, trimFraction: best.trimFraction };
  output.validation = { full: full.stats, firstHalf: h1.stats, secondHalf: h2.stats, oos: oos.stats, bothPositive };

  writeFileSync("data/partial-trim-c1-5m-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/partial-trim-c1-5m-results.json");
}

main();
