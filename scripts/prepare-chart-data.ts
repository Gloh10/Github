import { readFileSync, writeFileSync } from "node:fs";
import type { EquityPoint, StrategyResult } from "../src/backtest/types.js";

interface RawResults {
  fiveMinute: { windowStart: number; windowEnd: number; strategies: StrategyResult[]; benchmarkNQ: EquityPoint[] };
  daily: {
    windowStart: number;
    windowEnd: number;
    strategies: StrategyResult[];
    benchmarkNQ: EquityPoint[];
    benchmarkSPX: EquityPoint[];
  };
}

function downsample(points: EquityPoint[], maxPoints: number): EquityPoint[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out: EquityPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  out.push(points[points.length - 1]!);
  return out;
}

function main() {
  const raw = JSON.parse(readFileSync("data/backtest-results.json", "utf-8")) as RawResults;

  const chartData = {
    fiveMinute: {
      windowStart: raw.fiveMinute.windowStart,
      windowEnd: raw.fiveMinute.windowEnd,
      benchmarkNQ: downsample(raw.fiveMinute.benchmarkNQ, 300),
      strategies: raw.fiveMinute.strategies.map((s) => ({
        name: s.strategyName,
        equityCurve: s.equityCurve,
        stats: s.stats,
      })),
    },
    daily: {
      windowStart: raw.daily.windowStart,
      windowEnd: raw.daily.windowEnd,
      benchmarkNQ: raw.daily.benchmarkNQ,
      benchmarkSPX: raw.daily.benchmarkSPX,
      strategies: raw.daily.strategies.map((s) => ({
        name: s.strategyName,
        equityCurve: s.equityCurve,
        stats: s.stats,
      })),
    },
  };

  writeFileSync("data/chart-data.json", JSON.stringify(chartData));
  console.log(
    `Wrote data/chart-data.json — 5m benchmark ${chartData.fiveMinute.benchmarkNQ.length}pts, daily benchmark ${chartData.daily.benchmarkNQ.length}pts`,
  );
}

main();
