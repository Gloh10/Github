import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy, simulateTradesWithBreakeven } from "../src/backtest/engine.js";
import { rollingVwap } from "../src/backtest/indicators.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}

/** Overrides every signal's target to be `targetR` multiples of its own (entry, stop) risk. */
function overrideTargetR(signals: Signal[], targetR: number): Signal[] {
  return signals.map((s) => {
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * targetR : s.entry - risk * targetR;
    return { ...s, target };
  });
}

function main() {
  const nq1d = loadBars("data/nq-1d.json");
  const vwapDaily = rollingVwap(nq1d, 20);

  const daily_meanRev = vwapMeanReversion(nq1d, vwapDaily, { flatSlopePct: 1, slopeLookback: 10 });
  const daily_trend = vwapTrendContinuation(nq1d, vwapDaily, { trendSlopePct: 1, slopeLookback: 10 });
  const baseSignals = merge(daily_meanRev, daily_trend);

  console.log(`C1 base signals (entry/stop logic unchanged): ${baseSignals.length}`);

  const original = runStrategy("C1 original (as previously reported: VWAP-target mean-rev + 2R trend, no breakeven)", nq1d, baseSignals);
  console.log(
    `\nOriginal C1 for reference: trades=${original.stats.totalTrades}  winRate=${(original.stats.winRate * 100).toFixed(1)}%  ` +
      `totalR=${original.stats.totalR.toFixed(1)}  $100 -> $${original.stats.finalEquity.toFixed(2)}`,
  );
  console.log(
    "Note: the sweep below overrides BOTH sub-strategies' targets to a uniform fixed R-multiple (so R is a fair, comparable dial),\n" +
      "which replaces mean-reversion's original adaptive VWAP-level target. So the R=2/no-breakeven grid cell below will NOT\n" +
      "exactly reproduce the number above — this is a deliberate, disclosed change to make the sweep meaningful.\n",
  );

  const rMultiples = [1, 1.5, 2, 2.5, 3, 4, 5];
  const breakevens: (number | null)[] = [null, 0.5, 1, 1.5, 2];

  interface Cell {
    r: number;
    breakeven: number | null;
    result: StrategyResult;
  }
  const grid: Cell[] = [];

  for (const r of rMultiples) {
    const signals = overrideTargetR(baseSignals, r);
    for (const be of breakevens) {
      const trades = simulateTradesWithBreakeven(nq1d, signals, be);
      const curve = buildEquityCurve(nq1d, trades);
      const stats = computeStats(trades, curve);
      grid.push({
        r,
        breakeven: be,
        result: { strategyName: `R=${r}, breakeven=${be ?? "none"}`, trades, equityCurve: curve, stats },
      });
    }
  }

  console.log("=== Grid: final equity from $100 (rows=target R, cols=breakeven trigger in R) ===");
  const header = "R\\breakeven".padEnd(14) + breakevens.map((b) => (b === null ? "none" : `${b}R`).padStart(10)).join("");
  console.log(header);
  for (const r of rMultiples) {
    const row = grid.filter((c) => c.r === r);
    const line = String(r).padEnd(14) + row.map((c) => `$${c.result.stats.finalEquity.toFixed(2)}`.padStart(10)).join("");
    console.log(line);
  }

  console.log("\n=== Grid: win rate % (rows=target R, cols=breakeven trigger in R) ===");
  console.log(header);
  for (const r of rMultiples) {
    const row = grid.filter((c) => c.r === r);
    const line =
      String(r).padEnd(14) + row.map((c) => `${(c.result.stats.winRate * 100).toFixed(1)}%`.padStart(10)).join("");
    console.log(line);
  }

  const ranked = [...grid].sort((a, b) => b.result.stats.finalEquity - a.result.stats.finalEquity);
  console.log("\n=== Top 10 by final equity from $100 (all 35 combos tried) ===");
  ranked.slice(0, 10).forEach((c, i) => {
    const s = c.result.stats;
    console.log(
      `${String(i + 1).padStart(2)}. R=${c.r}, breakeven=${c.breakeven ?? "none"}  ` +
        `trades=${s.totalTrades}  winRate=${(s.winRate * 100).toFixed(1)}%  totalR=${s.totalR.toFixed(1)}  ` +
        `maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
    );
  });

  writeFileSync(
    "data/optimize-c1-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        original,
        grid: grid.map((c) => ({ r: c.r, breakeven: c.breakeven, stats: c.result.stats })),
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/optimize-c1-results.json");
}

main();
