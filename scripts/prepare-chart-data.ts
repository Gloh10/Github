import { readFileSync, writeFileSync } from "node:fs";
import type { EquityPoint, StrategyResult } from "../src/backtest/types.js";

interface BacktestResults {
  fiveMinute: { benchmarkNQ: EquityPoint[]; strategies: StrategyResult[] };
  daily: { benchmarkNQ: EquityPoint[]; benchmarkSPX: EquityPoint[]; strategies: StrategyResult[] };
}
interface CombinationResults {
  baselines: StrategyResult[];
  combos: StrategyResult[];
}

function downsample(points: EquityPoint[], maxPoints: number): EquityPoint[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out: EquityPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  out.push(points[points.length - 1]!);
  return out;
}

function find(all: StrategyResult[], name: string): StrategyResult {
  const found = all.find((s) => s.strategyName === name);
  if (!found) throw new Error(`Strategy not found: ${name}`);
  return found;
}

function slim(s: StrategyResult) {
  return { name: s.strategyName, equityCurve: s.equityCurve, stats: s.stats };
}

function main() {
  const bt = JSON.parse(readFileSync("data/backtest-results.json", "utf-8")) as BacktestResults;
  const combo = JSON.parse(readFileSync("data/combination-results.json", "utf-8")) as CombinationResults;
  const allCombo = [...combo.baselines, ...combo.combos];

  const chartData = {
    daily: {
      benchmarkNQ: bt.daily.benchmarkNQ,
      benchmarkSPX: bt.daily.benchmarkSPX,
      highlighted: [
        slim(find(allCombo, "Daily: Mean Reversion (Setup 2)")),
        slim(find(allCombo, "Daily: Trend Continuation (Setup 3)")),
        slim(find(allCombo, "C1. Daily: Mean-Rev + Trend-Continuation merged (regime-adaptive)")),
      ],
    },
    fiveMinute: {
      benchmarkNQ: downsample(bt.fiveMinute.benchmarkNQ, 300),
      highlighted: [
        slim(find(allCombo, "5m: SD+OTE, confluence>=3 (Setup 5d)")),
        slim(find(allCombo, "5m: SFP + FVG, unfiltered (Setup 6a)")),
        slim(find(allCombo, "C6. 5m: everything merged (MeanRev + Trend + SD-OTE + SFP), first signal wins")),
      ],
    },
    // Every variant tested, for the full table — not just what's charted.
    allResults: [
      ...bt.daily.strategies.map((s) => ({ ...slim(s), group: "daily-original" })),
      ...bt.fiveMinute.strategies.map((s) => ({ ...slim(s), group: "5min-original" })),
      ...combo.baselines.map((s) => ({ ...slim(s), group: "baseline" })),
      ...combo.combos.map((s) => ({ ...slim(s), group: "combination" })),
    ],
  };

  writeFileSync("data/chart-data.json", JSON.stringify(chartData));
  console.log(`Wrote data/chart-data.json — ${chartData.allResults.length} total variants in the full table`);
}

main();
