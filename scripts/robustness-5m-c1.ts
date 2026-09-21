import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;

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

function runCombo(
  name: string,
  bars: Bar[],
  targetR: number,
  opts: { flatSlopePct: number; trendSlopePct: number; slopeLookback: number },
): StrategyResult {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: opts.flatSlopePct, slopeLookback: opts.slopeLookback });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: opts.trendSlopePct, slopeLookback: opts.slopeLookback });
  const signals = overrideTargetR(merge(meanRev, trend), targetR);
  return runStrategy(name, bars, signals);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(46)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}

const DEFAULT_PARAMS = { flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 12 };
const R_LEVELS = [
  { label: "R=5 (current best)", targetR: 5 },
  { label: "R=2 (lower RR)", targetR: 2 },
];

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  console.log("=".repeat(78));
  console.log("BASELINE: full period, both R levels (5-min NQ, session VWAP, no breakeven)");
  console.log("=".repeat(78));
  const baseline = R_LEVELS.map((level) => runCombo(level.label, nq5m, level.targetR, DEFAULT_PARAMS));
  baseline.forEach(summarize);
  output.baseline = baseline;

  // ============================================================
  // CHECK 1: Split-period robustness
  // ============================================================
  console.log("\n" + "=".repeat(78));
  console.log("CHECK 1: Split-period robustness (same unchanged params)");
  console.log("=".repeat(78));
  const mid = Math.floor(nq5m.length / 2);
  const firstHalf = nq5m.slice(0, mid);
  const secondHalf = nq5m.slice(mid);
  console.log(
    `First half:  ${new Date(firstHalf[0]!.t * 1000).toISOString()} -> ${new Date(firstHalf[firstHalf.length - 1]!.t * 1000).toISOString()}`,
  );
  console.log(
    `Second half: ${new Date(secondHalf[0]!.t * 1000).toISOString()} -> ${new Date(secondHalf[secondHalf.length - 1]!.t * 1000).toISOString()}`,
  );
  const splitPeriod: Record<string, unknown> = {};
  for (const level of R_LEVELS) {
    console.log(`\n-- ${level.label} --`);
    const full = runCombo("Full period", nq5m, level.targetR, DEFAULT_PARAMS);
    const h1 = runCombo("First half", firstHalf, level.targetR, DEFAULT_PARAMS);
    const h2 = runCombo("Second half", secondHalf, level.targetR, DEFAULT_PARAMS);
    [full, h1, h2].forEach(summarize);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(
      bothPositive
        ? "Verdict: POSITIVE in both halves -- passes this check."
        : "Verdict: NOT positive in both halves -- the edge is concentrated in one period, a real overfitting warning sign.",
    );
    splitPeriod[level.label] = { full: full.stats, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive };
  }
  output.splitPeriod = splitPeriod;

  // ============================================================
  // CHECK 2: Parameter sensitivity grid
  // ============================================================
  console.log("\n" + "=".repeat(78));
  console.log("CHECK 2: Parameter sensitivity (slope threshold % x lookback bars), full period");
  console.log("=".repeat(78));
  const slopeValues = [0.1, 0.15, 0.2, 0.3, 0.5];
  const lookbackValues = [6, 9, 12, 15, 20];
  const paramGrids: Record<string, unknown> = {};
  for (const level of R_LEVELS) {
    console.log(`\n-- ${level.label}: totalR grid (rows=slope %, cols=lookback bars) --`);
    const header = "slope\\lookback".padEnd(16) + lookbackValues.map((l) => String(l).padStart(8)).join("");
    console.log(header);
    const grid: number[][] = [];
    for (const slope of slopeValues) {
      const row: number[] = [];
      for (const lookback of lookbackValues) {
        const r = runCombo("grid", nq5m, level.targetR, { flatSlopePct: slope, trendSlopePct: slope, slopeLookback: lookback });
        row.push(r.stats.totalR);
      }
      grid.push(row);
      console.log(String(slope).padEnd(16) + row.map((v) => v.toFixed(1).padStart(8)).join(""));
    }
    const flat = grid.flat();
    const positiveCount = flat.filter((v) => v > 0).length;
    const originalValue = grid[1]![2]!; // slope=0.15, lookback=12 (as used throughout this project)
    console.log(
      `${positiveCount}/${flat.length} grid cells positive (${((positiveCount / flat.length) * 100).toFixed(0)}%). ` +
        `Originally-reported combo (slope=0.15%, lookback=12) scored ${originalValue.toFixed(1)}R -- ` +
        `${originalValue === Math.max(...flat) ? "the single BEST cell in the grid" : `rank ${flat.filter((v) => v > originalValue).length + 1} of ${flat.length}`}.`,
    );
    paramGrids[level.label] = { slopeValues, lookbackValues, grid, positiveCount, total: flat.length, originalValue };
  }
  output.paramGrids = paramGrids;

  // ============================================================
  // CHECK 3: Transaction cost sensitivity
  // ============================================================
  console.log("\n" + "=".repeat(78));
  console.log("CHECK 3: Transaction cost sensitivity (original params, full period)");
  console.log("=".repeat(78));
  const costScenarios = [
    { label: "No cost (as originally reported)", usd: 0 },
    { label: "Low-cost broker (~$5 commission + 0.5pt slippage)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 commission + 1pt slippage)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative/thin liquidity (~$10 + 2pt slippage)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];
  const costResults: Record<string, unknown> = {};
  for (const level of R_LEVELS) {
    console.log(`\n-- ${level.label} --`);
    const full = runCombo("full", nq5m, level.targetR, DEFAULT_PARAMS);
    const rawTrades = full.trades;
    const avgRiskPoints = rawTrades.length > 0 ? rawTrades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / rawTrades.length : 0;
    console.log(`${rawTrades.length} trades, average stop distance ${avgRiskPoints.toFixed(1)} NQ points ($${(avgRiskPoints * NQ_POINT_VALUE_USD).toFixed(0)}/contract).`);
    const scenarioResults: { label: string; usd: number; totalR: number; avgR: number; finalEquity: number }[] = [];
    for (const scenario of costScenarios) {
      const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
      const adjusted = applyCost(rawTrades, costPoints);
      const curve = buildEquityCurve(nq5m, adjusted);
      const stats = computeStats(adjusted, curve);
      console.log(
        `${scenario.label.padEnd(52)} ($${scenario.usd.toFixed(2)}/trade) totalR=${stats.totalR.toFixed(1)}  avgR=${stats.avgR.toFixed(2)}  finalEquity=${stats.finalEquity.toFixed(1)}`,
      );
      scenarioResults.push({ label: scenario.label, usd: scenario.usd, totalR: stats.totalR, avgR: stats.avgR, finalEquity: stats.finalEquity });
    }
    costResults[level.label] = { avgRiskPoints, scenarios: scenarioResults };
  }
  output.costResults = costResults;

  // ============================================================
  // CHECK 4: Out-of-sample on ES 5-min
  // ============================================================
  console.log("\n" + "=".repeat(78));
  console.log("CHECK 4: Out-of-sample -- identical rules run fresh on ES 5-min (own signals, not NQ signals w/ ES data)");
  console.log("=".repeat(78));
  const outOfSample = R_LEVELS.map((level) => runCombo(`${level.label}, ES 5-min`, es5m, level.targetR, DEFAULT_PARAMS));
  outOfSample.forEach(summarize);
  output.outOfSample = outOfSample;

  writeFileSync("data/robustness-5m-c1-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/robustness-5m-c1-results.json");
}

main();
