import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
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
function avgVolume(bars: Bar[], lookback: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.v;
    if (i >= lookback) sum -= bars[i - lookback]!.v;
    if (i >= lookback - 1) out[i] = sum / lookback;
  }
  return out;
}

function build(bars: Bar[], multiple: number, lookback: number): StrategyResult {
  const avgVol = avgVolume(bars, lookback);
  let signals = baseSignals(bars).filter((s) => {
    const avg = avgVol[s.barIndex]!;
    if (isNaN(avg) || avg === 0) return false;
    return bars[s.barIndex]!.v / avg >= multiple;
  });
  signals = overrideTargetR(signals, 5);
  const trades = simulateTradesWithSessionDeadline(bars, signals, DEADLINE);
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: `mult=${multiple},lb=${lookback}`, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const multiples = [1.2, 1.5, 1.75, 2, 2.5, 3];
  const lookbacks = [10, 15, 20, 30, 40];
  const mid = Math.floor(nq5m.length / 2);

  const MIN_RELIABLE_TRADES = 10; // below this, treat the cell's result as too noisy to weigh

  console.log("=".repeat(130));
  console.log("Sensitivity sweep -- volume-spike confirmation filter (multiplier x lookback)");
  console.log("=".repeat(130));
  console.log(`Baseline (no filter): trades=45, totalR=57.8, OOS-ES totalR=28.6, OOS-RTY totalR=-2.0\n`);

  console.log("Mult  LB   Trades  AvgR   TotalR   MaxDD   SplitBothPos  OOS-ES-AvgR  OOS-RTY-AvgR  BothOosPositive  Reliable(n>=10)");
  console.log("-".repeat(130));

  const summary: Record<string, unknown>[] = [];
  for (const mult of multiples) {
    for (const lb of lookbacks) {
      const full = build(nq5m, mult, lb);
      const h1 = build(nq5m.slice(0, mid), mult, lb);
      const h2 = build(nq5m.slice(mid), mult, lb);
      const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
      const oosEs = build(es5m, mult, lb);
      const oosRty = build(rty5m, mult, lb);
      const bothOosPositive = oosEs.stats.totalR > 0 && oosRty.stats.totalR > 0;
      const reliable = full.stats.totalTrades >= MIN_RELIABLE_TRADES && oosEs.stats.totalTrades >= MIN_RELIABLE_TRADES && oosRty.stats.totalTrades >= MIN_RELIABLE_TRADES;

      console.log(
        `${mult.toString().padStart(4)}  ${lb.toString().padStart(3)}  ${String(full.stats.totalTrades).padStart(6)}  ` +
          `${full.stats.avgR.toFixed(2).padStart(5)}  ${full.stats.totalR.toFixed(1).padStart(7)}  ${full.stats.maxDrawdownPct.toFixed(1).padStart(5)}%   ` +
          `${(bothPositive ? "YES" : "NO").padStart(11)}  ${oosEs.stats.avgR.toFixed(2).padStart(11)}  ${oosRty.stats.avgR.toFixed(2).padStart(12)}  ${(bothOosPositive ? "YES" : "NO").padStart(15)}  ${(reliable ? "YES" : "no").padStart(15)}`,
      );

      summary.push({
        mult,
        lookback: lb,
        trades: full.stats.totalTrades,
        avgR: full.stats.avgR,
        totalR: full.stats.totalR,
        maxDD: full.stats.maxDrawdownPct,
        splitBothPositive: bothPositive,
        oosEsAvgR: oosEs.stats.avgR,
        oosEsTrades: oosEs.stats.totalTrades,
        oosRtyAvgR: oosRty.stats.avgR,
        oosRtyTrades: oosRty.stats.totalTrades,
        bothOosPositive,
        reliable,
      });
    }
  }

  const reliableCells = summary.filter((s: any) => s.reliable);
  const reliablePass = reliableCells.filter((s: any) => s.splitBothPositive && s.bothOosPositive);
  console.log("\n" + "=".repeat(130));
  console.log(`VERDICT: ${reliableCells.length}/${summary.length} cells have >=10 trades in every dataset (in-sample + both OOS).`);
  console.log(`Of those reliable cells, ${reliablePass.length}/${reliableCells.length} pass BOTH split-period AND both-OOS-positive.`);
  console.log("=".repeat(130));

  writeFileSync("data/flagship-volume-spike-sensitivity-sweep-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2));
  console.log("\nFull results written to data/flagship-volume-spike-sensitivity-sweep-results.json");
}

main();
