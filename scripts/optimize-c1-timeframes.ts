import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy, simulateTradesWithBreakeven } from "../src/backtest/engine.js";
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

interface Cell {
  r: number;
  breakeven: number | null;
  result: StrategyResult;
}

function runGrid(bars: Bar[], baseSignals: Signal[], rMultiples: number[], breakevens: (number | null)[]): Cell[] {
  const grid: Cell[] = [];
  for (const r of rMultiples) {
    const signals = overrideTargetR(baseSignals, r);
    for (const be of breakevens) {
      const trades = simulateTradesWithBreakeven(bars, signals, be);
      const curve = buildEquityCurve(bars, trades);
      const stats = computeStats(trades, curve);
      grid.push({ r, breakeven: be, result: { strategyName: `R=${r}, breakeven=${be ?? "none"}`, trades, equityCurve: curve, stats } });
    }
  }
  return grid;
}

function printGrid(label: string, grid: Cell[], rMultiples: number[], breakevens: (number | null)[]) {
  console.log(`\n--- ${label}: final equity from $100 (rows=target R, cols=breakeven trigger in R) ---`);
  const header = "R\\breakeven".padEnd(14) + breakevens.map((b) => (b === null ? "none" : `${b}R`).padStart(10)).join("");
  console.log(header);
  for (const r of rMultiples) {
    const row = grid.filter((c) => c.r === r);
    console.log(String(r).padEnd(14) + row.map((c) => `$${c.result.stats.finalEquity.toFixed(2)}`.padStart(10)).join(""));
  }
}

function main() {
  const rMultiples = [1, 1.5, 2, 2.5, 3, 4, 5];
  const breakevens: (number | null)[] = [null, 0.5, 1, 1.5, 2];

  const timeframes: { label: string; bars: Bar[]; flatSlopePct: number; trendSlopePct: number; slopeLookback: number }[] = [
    { label: "5-min", bars: loadBars("data/nq-5m.json"), flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 12 },
    { label: "15-min", bars: loadBars("data/nq-15m.json"), flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 8 },
    { label: "1-hour", bars: loadBars("data/nq-1h.json"), flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 6 },
  ];

  console.log(
    "Signal-generation params (session VWAP, unchanged from C1's entry/stop logic): flatSlopePct=trendSlopePct=0.15%,\n" +
      "slopeLookback = 12 bars (5m, ~60min) / 8 bars (15m, ~2h) / 6 bars (1h, ~6h) — each representing a comparable\n" +
      "intraday analysis window in wall-clock terms, not an identical bar count.\n",
  );

  const allResults: { timeframe: string; barCount: number; original: StrategyResult; best: Cell; grid: Cell[] }[] = [];

  for (const tf of timeframes) {
    const vwap = sessionVwap(tf.bars);
    const meanRev = vwapMeanReversion(tf.bars, vwap, { flatSlopePct: tf.flatSlopePct, slopeLookback: tf.slopeLookback });
    const trend = vwapTrendContinuation(tf.bars, vwap, { trendSlopePct: tf.trendSlopePct, slopeLookback: tf.slopeLookback });
    const baseSignals = merge(meanRev, trend);

    const original = runStrategy(`C1 (${tf.label}, original targets, no breakeven)`, tf.bars, baseSignals);
    console.log(
      `=== ${tf.label} (${tf.bars.length} bars) === base signals=${baseSignals.length}, ` +
        `original: trades=${original.stats.totalTrades} winRate=${(original.stats.winRate * 100).toFixed(1)}% ` +
        `totalR=${original.stats.totalR.toFixed(1)} $100 -> $${original.stats.finalEquity.toFixed(2)}`,
    );

    const grid = runGrid(tf.bars, baseSignals, rMultiples, breakevens);
    printGrid(tf.label, grid, rMultiples, breakevens);

    const ranked = [...grid].sort((a, b) => b.result.stats.finalEquity - a.result.stats.finalEquity);
    const best = ranked[0]!;
    console.log(
      `Best for ${tf.label}: R=${best.r}, breakeven=${best.breakeven ?? "none"}  ` +
        `trades=${best.result.stats.totalTrades}  winRate=${(best.result.stats.winRate * 100).toFixed(1)}%  ` +
        `totalR=${best.result.stats.totalR.toFixed(1)}  maxDD=${best.result.stats.maxDrawdownPct.toFixed(1)}%  ` +
        `$100 -> $${best.result.stats.finalEquity.toFixed(2)}\n`,
    );

    allResults.push({ timeframe: tf.label, barCount: tf.bars.length, original, best, grid });
  }

  console.log("=== Cross-timeframe ranking: each timeframe's own best R/breakeven config ===");
  [...allResults]
    .sort((a, b) => b.best.result.stats.finalEquity - a.best.result.stats.finalEquity)
    .forEach((r, i) => {
      const s = r.best.result.stats;
      console.log(
        `${i + 1}. ${r.timeframe} (R=${r.best.r}, breakeven=${r.best.breakeven ?? "none"}) — ` +
          `$100 -> $${s.finalEquity.toFixed(2)}, trades=${s.totalTrades}, winRate=${(s.winRate * 100).toFixed(1)}%, ` +
          `maxDD=${s.maxDrawdownPct.toFixed(1)}%, window=${r.barCount} bars`,
      );
    });

  writeFileSync(
    "data/optimize-c1-timeframes-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        results: allResults.map((r) => ({
          timeframe: r.timeframe,
          barCount: r.barCount,
          original: r.original,
          best: { r: r.best.r, breakeven: r.best.breakeven, stats: r.best.result.stats },
          grid: r.grid.map((c) => ({ r: c.r, breakeven: c.breakeven, stats: c.result.stats })),
        })),
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/optimize-c1-timeframes-results.json");
}

main();
