import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import { rollingValueArea } from "../src/backtest/volumeProfile.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}
const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];
function dayHourFilter(bars: Bar[], signals: Signal[]): Signal[] {
  return signals.filter((s) => {
    const bar = bars[s.barIndex]!;
    const hour = nyHour(bar.t);
    const weekday = nyWeekday(bar.t);
    if (EXCLUDED_HOURS.includes(hour)) return false;
    if (weekday === 0) return false;
    if (weekday === 1 && EXCLUDED_MONDAY_HOURS.includes(hour)) return false;
    return true;
  });
}
function overrideTargetR(signals: Signal[], targetR: number): Signal[] {
  return signals.map((s) => {
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * targetR : s.entry - risk * targetR;
    return { ...s, target };
  });
}
function baseSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  return dayHourFilter(bars, merge(meanRev, trend));
}

function build(bars: Bar[], lookback: number | null): StrategyResult {
  let signals = baseSignals(bars);
  if (lookback !== null) {
    const va = rollingValueArea(bars, lookback);
    signals = signals.filter((s) => {
      const v = va[s.barIndex];
      if (!v) return false;
      return s.direction === "short" ? s.stop > v.vah : s.stop < v.val;
    });
  }
  signals = overrideTargetR(signals, 5);
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour: 16, deadlineMinute: 45 });
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: lookback === null ? "baseline" : `lookback=${lookback}`, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const lookbacks = [20, 40, 60, 75, 100, 150, 200, 288, 400];
  const mid = Math.floor(nq5m.length / 2);

  console.log("=".repeat(120));
  console.log("Lookback sensitivity sweep -- 'outside value area' filter on the flagship strategy");
  console.log("=".repeat(120));
  console.log("Testing whether the improvement found at lookback=100 holds across a range, or was a one-off pick.\n");

  const baseline = build(nq5m, null);
  const baselineOos = build(es5m, null);
  console.log(`BASELINE (no VA filter)   trades=${baseline.stats.totalTrades}  winRate=${(baseline.stats.winRate * 100).toFixed(1)}%  avgR=${baseline.stats.avgR.toFixed(2)}  totalR=${baseline.stats.totalR.toFixed(1)}  maxDD=${baseline.stats.maxDrawdownPct.toFixed(1)}%  OOS totalR=${baselineOos.stats.totalR.toFixed(1)}\n`);

  console.log("Lookback  Trades  WinRate  AvgR    TotalR   MaxDD   SplitBothPos  OOS(ES)TotalR  OOS(ES)AvgR");
  console.log("-".repeat(120));

  const summary: Record<string, unknown>[] = [];
  for (const lb of lookbacks) {
    const full = build(nq5m, lb);
    const h1 = build(nq5m.slice(0, mid), lb);
    const h2 = build(nq5m.slice(mid), lb);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    const oos = build(es5m, lb);

    console.log(
      `${String(lb).padStart(8)}  ${String(full.stats.totalTrades).padStart(6)}  ` +
        `${(full.stats.winRate * 100).toFixed(1).padStart(6)}%  ${full.stats.avgR.toFixed(2).padStart(5)}  ` +
        `${full.stats.totalR.toFixed(1).padStart(7)}  ${full.stats.maxDrawdownPct.toFixed(1).padStart(5)}%   ` +
        `${(bothPositive ? "YES" : "NO").padStart(11)}  ${oos.stats.totalR.toFixed(1).padStart(13)}  ${oos.stats.avgR.toFixed(2).padStart(10)}`,
    );

    summary.push({
      lookback: lb,
      trades: full.stats.totalTrades,
      winRate: full.stats.winRate * 100,
      avgR: full.stats.avgR,
      totalR: full.stats.totalR,
      maxDD: full.stats.maxDrawdownPct,
      splitBothPositive: bothPositive,
      oosTotalR: oos.stats.totalR,
      oosAvgR: oos.stats.avgR,
      oosTrades: oos.stats.totalTrades,
    });
  }

  console.log("\n" + "=".repeat(120));
  console.log("VERDICT");
  console.log("=".repeat(120));
  const beatsBaselineAvgR = summary.filter((s: any) => s.avgR > baseline.stats.avgR);
  const positiveOosCount = summary.filter((s: any) => s.oosTotalR > 0).length;
  const splitPassCount = summary.filter((s: any) => s.splitBothPositive).length;
  console.log(`Baseline avgR: ${baseline.stats.avgR.toFixed(2)}. Lookbacks that beat it: ${beatsBaselineAvgR.length}/${lookbacks.length} (${(beatsBaselineAvgR as any[]).map((s) => s.lookback).join(", ")})`);
  console.log(`Lookbacks passing split-period (both halves positive): ${splitPassCount}/${lookbacks.length}`);
  console.log(`Lookbacks with positive OOS(ES) totalR: ${positiveOosCount}/${lookbacks.length}`);

  writeFileSync("data/flagship-volume-profile-lookback-sweep-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), baseline: baseline.stats, baselineOos: baselineOos.stats, summary }, null, 2));
  console.log("\nFull results written to data/flagship-volume-profile-lookback-sweep-results.json");
}

main();
