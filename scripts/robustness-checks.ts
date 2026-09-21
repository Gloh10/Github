import { readFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy } from "../src/backtest/engine.js";
import { rollingVwap } from "../src/backtest/indicators.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20; // standard E-mini NQ contract spec

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}
function dateOf(bar: Bar): string {
  return new Date(bar.t * 1000).toISOString().slice(0, 10);
}

function runCombo(name: string, bars: Bar[], flatSlopePct: number, trendSlopePct: number, slopeLookback: number) {
  const vwap = rollingVwap(bars, 20);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct, slopeLookback });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct, slopeLookback });
  return runStrategy(name, bars, merge(meanRev, trend));
}

function main() {
  const nq1d = loadBars("data/nq-1d.json");

  // ============================================================
  // CHECK 1: Split-period robustness (same unchanged parameters)
  // ============================================================
  console.log("=".repeat(70));
  console.log("CHECK 1: Split-period robustness (flat=1%, trend=1%, lookback=20)");
  console.log("=".repeat(70));

  const mid = Math.floor(nq1d.length / 2);
  const firstHalf = nq1d.slice(0, mid);
  const secondHalf = nq1d.slice(mid);

  const full = runCombo("Full period", nq1d, 1, 1, 10);
  const h1 = runCombo("First half", firstHalf, 1, 1, 10);
  const h2 = runCombo("Second half", secondHalf, 1, 1, 10);

  for (const [r, bars] of [
    [full, nq1d],
    [h1, firstHalf],
    [h2, secondHalf],
  ] as const) {
    console.log(
      `${r.strategyName.padEnd(14)} ${dateOf(bars[0]!)} → ${dateOf(bars[bars.length - 1]!)}  ` +
        `trades=${String(r.stats.totalTrades).padStart(3)}  winRate=${(r.stats.winRate * 100).toFixed(1)}%  ` +
        `avgR=${r.stats.avgR.toFixed(2)}  totalR=${r.stats.totalR.toFixed(1)}  maxDD=${r.stats.maxDrawdownPct.toFixed(1)}%`,
    );
  }
  const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
  console.log(
    `\nVerdict: ${bothPositive ? "POSITIVE in both halves — passes this check." : "NOT positive in both halves — the edge is concentrated in one period, a real overfitting warning sign."}`,
  );

  // ============================================================
  // CHECK 2: Parameter sensitivity grid
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("CHECK 2: Parameter sensitivity (full 5-year period)");
  console.log("=".repeat(70));

  const slopeValues = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const lookbackValues = [5, 10, 15, 20, 30];

  console.log(`\ntotalR grid — rows=slope threshold %, cols=slope lookback (bars):`);
  const header = "slope\\lookback".padEnd(16) + lookbackValues.map((l) => String(l).padStart(8)).join("");
  console.log(header);
  const grid: number[][] = [];
  for (const slope of slopeValues) {
    const row: number[] = [];
    for (const lookback of lookbackValues) {
      const r = runCombo("grid", nq1d, slope, slope, lookback);
      row.push(r.stats.totalR);
    }
    grid.push(row);
    console.log(String(slope).padEnd(16) + row.map((v) => v.toFixed(1).padStart(8)).join(""));
  }

  const flatCount = grid.flat().length;
  const positiveCount = grid.flat().filter((v) => v > 0).length;
  const originalValue = grid[2]![1]!; // slope=1, lookback=10
  console.log(
    `\n${positiveCount}/${flatCount} grid cells positive (${((positiveCount / flatCount) * 100).toFixed(0)}%). ` +
      `Originally-reported combo (slope=1%, lookback=10) scored ${originalValue.toFixed(1)}R — ` +
      `${originalValue === Math.max(...grid.flat()) ? "the single BEST cell in the grid" : `rank ${grid.flat().filter((v) => v > originalValue).length + 1} of ${flatCount}`}.`,
  );

  // ============================================================
  // CHECK 3: Transaction cost sensitivity
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("CHECK 3: Transaction cost sensitivity (original combo, full period)");
  console.log("=".repeat(70));

  function applyCost(trades: Trade[], costPoints: number): Trade[] {
    return trades.map((t) => {
      const riskPoints = Math.abs(t.entry - t.stop);
      const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
      return { ...t, rMultiple: t.rMultiple - costR };
    });
  }

  const rawTrades = full.trades;
  const avgRiskPoints = rawTrades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / rawTrades.length;
  console.log(`\n${rawTrades.length} trades, average stop distance ${avgRiskPoints.toFixed(1)} NQ points.`);
  console.log(`NQ point value: $${NQ_POINT_VALUE_USD}/point (1 standard E-mini contract).\n`);

  const costScenarios = [
    { label: "No cost (as originally reported)", usd: 0 },
    { label: "Low-cost broker (~$5 commission + 0.5pt slippage)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 commission + 1pt slippage)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative/thin liquidity (~$10 + 2pt slippage)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];

  for (const scenario of costScenarios) {
    const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(rawTrades, costPoints);
    const curve = buildEquityCurve(nq1d, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(
      `${scenario.label.padEnd(52)} ($${scenario.usd.toFixed(2)}/trade, ${costPoints.toFixed(2)}pt) ` +
        `totalR=${stats.totalR.toFixed(1)}  avgR=${stats.avgR.toFixed(2)}  finalEquity=${stats.finalEquity.toFixed(1)}`,
    );
  }
}

main();
