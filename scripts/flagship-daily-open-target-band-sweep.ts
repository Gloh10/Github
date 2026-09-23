import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { keyOpenLevels } from "../src/backtest/keyOpens.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

const DEADLINE = { deadlineHour: 16, deadlineMinute: 45 };

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
function baseSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  return dayHourFilter(bars, merge(meanRev, trend));
}

function build(bars: Bar[], minR: number, maxR: number): StrategyResult {
  const levels = keyOpenLevels(bars, "daily");
  const signals = baseSignals(bars).map((s) => {
    const risk = Math.abs(s.entry - s.stop);
    const level = levels[s.barIndex]!;
    const levelAhead = s.direction === "long" ? level > s.entry : level < s.entry;
    const levelR = risk > 0 ? Math.abs(level - s.entry) / risk : 0;
    if (levelAhead && levelR >= minR && levelR <= maxR) {
      return { ...s, target: level };
    }
    const target = s.direction === "long" ? s.entry + risk * 5 : s.entry - risk * 5;
    return { ...s, target };
  });
  const trades = simulateTradesWithSessionDeadline(bars, signals, DEADLINE);
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: `minR=${minR},maxR=${maxR}`, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const minRs = [0.5, 1, 1.5, 2, 3];
  const maxRs = [6, 8, 10, 12, 15];
  const mid = Math.floor(nq5m.length / 2);

  const baseline = build(nq5m, 0, 0); // minR=0,maxR=0 -> levelAhead but levelR>=0 && <=0 basically never true except levelR=0, so effectively always falls back to R=5
  const baselineOosEs = build(es5m, 0, 0);
  const baselineOosRty = build(rty5m, 0, 0);
  console.log("=".repeat(120));
  console.log("R-band sensitivity sweep -- daily-open magnet target on the flagship strategy");
  console.log("=".repeat(120));
  console.log(`BASELINE (always R=5): totalR=${baseline.stats.totalR.toFixed(1)}  OOS-ES totalR=${baselineOosEs.stats.totalR.toFixed(1)}  OOS-RTY totalR=${baselineOosRty.stats.totalR.toFixed(1)}\n`);

  console.log("minR  maxR  Trades  AvgR   TotalR   MaxDD   SplitBothPos  OOS-ES-TotalR  OOS-RTY-TotalR  BothOosPositive");
  console.log("-".repeat(120));

  const summary: Record<string, unknown>[] = [];
  for (const minR of minRs) {
    for (const maxR of maxRs) {
      const full = build(nq5m, minR, maxR);
      const h1 = build(nq5m.slice(0, mid), minR, maxR);
      const h2 = build(nq5m.slice(mid), minR, maxR);
      const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
      const oosEs = build(es5m, minR, maxR);
      const oosRty = build(rty5m, minR, maxR);
      const bothOosPositive = oosEs.stats.totalR > 0 && oosRty.stats.totalR > 0;

      console.log(
        `${minR.toString().padStart(4)}  ${maxR.toString().padStart(4)}  ${String(full.stats.totalTrades).padStart(6)}  ` +
          `${full.stats.avgR.toFixed(2).padStart(5)}  ${full.stats.totalR.toFixed(1).padStart(7)}  ${full.stats.maxDrawdownPct.toFixed(1).padStart(5)}%   ` +
          `${(bothPositive ? "YES" : "NO").padStart(11)}  ${oosEs.stats.totalR.toFixed(1).padStart(13)}  ${oosRty.stats.totalR.toFixed(1).padStart(14)}  ${(bothOosPositive ? "YES" : "NO").padStart(15)}`,
      );

      summary.push({
        minR,
        maxR,
        trades: full.stats.totalTrades,
        avgR: full.stats.avgR,
        totalR: full.stats.totalR,
        maxDD: full.stats.maxDrawdownPct,
        splitBothPositive: bothPositive,
        oosEsTotalR: oosEs.stats.totalR,
        oosRtyTotalR: oosRty.stats.totalR,
        bothOosPositive,
      });
    }
  }

  const passCount = summary.filter((s: any) => s.bothOosPositive && s.splitBothPositive).length;
  console.log("\n" + "=".repeat(120));
  console.log(`VERDICT: ${passCount}/${summary.length} band combinations pass BOTH split-period AND both-OOS-markets-positive.`);
  console.log("=".repeat(120));

  writeFileSync("data/flagship-daily-open-target-band-sweep-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), baseline: baseline.stats, summary }, null, 2));
  console.log("\nFull results written to data/flagship-daily-open-target-band-sweep-results.json");
}

main();
