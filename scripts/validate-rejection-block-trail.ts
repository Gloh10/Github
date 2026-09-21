import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithPointsTrail } from "../src/backtest/engine.js";
import { rejectionBlock } from "../src/backtest/strategies.js";
import type { Bar, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(40)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

const OPTS = { breakevenTriggerPoints: 0, trailStartPoints: 5, trailDistancePoints: 2 };

function runBest(name: string, bars: Bar[]): StrategyResult {
  const signals = rejectionBlock(bars, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
  const trades = simulateTradesWithPointsTrail(bars, signals, OPTS);
  const curve = buildEquityCurve(bars, trades);
  const stats = computeStats(trades, curve);
  return { strategyName: name, trades, equityCurve: curve, stats };
}

function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}

function main() {
  const nq1h = loadBars("data/nq-1h.json");
  const es1h = loadBars("data/es-1h.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString(), config: OPTS };

  console.log("=".repeat(78));
  console.log("BASELINE: 1-hour NQ, rejection block alone, BE@0pt, trail@5pt/2pt");
  console.log("=".repeat(78));
  const full = runBest("Full period", nq1h);
  summarize(full);
  output.baseline = full.stats;

  console.log("\n" + "=".repeat(78));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(78));
  const mid = Math.floor(nq1h.length / 2);
  const firstHalf = nq1h.slice(0, mid);
  const secondHalf = nq1h.slice(mid);
  console.log(`First half:  ${new Date(firstHalf[0]!.t * 1000).toISOString()} -> ${new Date(firstHalf[firstHalf.length - 1]!.t * 1000).toISOString()}`);
  console.log(`Second half: ${new Date(secondHalf[0]!.t * 1000).toISOString()} -> ${new Date(secondHalf[secondHalf.length - 1]!.t * 1000).toISOString()}`);
  const h1 = runBest("First half", firstHalf);
  const h2 = runBest("Second half", secondHalf);
  [h1, h2].forEach(summarize);
  const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
  console.log(bothPositive ? "Verdict: POSITIVE in both halves." : "Verdict: NOT positive in both halves.");
  output.splitPeriod = { firstHalf: h1.stats, secondHalf: h2.stats, bothPositive };

  console.log("\n" + "=".repeat(78));
  console.log("CHECK 2: Transaction cost sensitivity");
  console.log("=".repeat(78));
  const rawTrades = full.trades;
  const avgRiskPoints = rawTrades.length > 0 ? rawTrades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / rawTrades.length : 0;
  console.log(`${rawTrades.length} trades, average stop distance ${avgRiskPoints.toFixed(1)} NQ points ($${(avgRiskPoints * NQ_POINT_VALUE_USD).toFixed(0)}/contract).`);
  const costScenarios = [
    { label: "No cost (as reported)", usd: 0 },
    { label: "Low-cost broker (~$5 + 0.5pt slippage)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 + 1pt slippage)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative (~$10 + 2pt slippage)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];
  const costResults: unknown[] = [];
  for (const scenario of costScenarios) {
    const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(rawTrades, costPoints);
    const curve = buildEquityCurve(nq1h, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${scenario.label.padEnd(42)} ($${scenario.usd.toFixed(2)}/trade) totalR=${stats.totalR.toFixed(1)}  avgR=${stats.avgR.toFixed(2)}  finalEquity=${stats.finalEquity.toFixed(1)}`);
    costResults.push({ ...scenario, totalR: stats.totalR, avgR: stats.avgR, finalEquity: stats.finalEquity });
  }
  output.costResults = { avgRiskPoints, scenarios: costResults };

  console.log("\n" + "=".repeat(78));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES 1-hour");
  console.log("=".repeat(78));
  const oos = runBest("ES 1-hour (OOS)", es1h);
  summarize(oos);
  output.outOfSample = oos.stats;

  writeFileSync("data/validate-rejection-block-trail-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/validate-rejection-block-trail-results.json");
}

main();
