import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyMinute, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;

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
function buildSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  return overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);
}

function buildOld(bars: Bar[]): StrategyResult {
  return runStrategy("OLD (no deadline, unrealistic on Lucid)", bars, buildSignals(bars));
}
function buildNew(bars: Bar[]): StrategyResult {
  const signals = buildSignals(bars);
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour: 16, deadlineMinute: 45 });
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: "NEW (4:45pm ET forced exit, LucidFlex-realistic)", trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function summarize(result: StrategyResult): string {
  const s = result.stats;
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%  $100 -> $${s.finalEquity.toFixed(2)}`;
}
function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  console.log("=".repeat(105));
  console.log("FULL PERIOD -- old (no deadline) vs new (4:45pm ET forced-exit, matches LucidFlex's real rule)");
  console.log("=".repeat(105));
  const oldFull = buildOld(nq5m);
  const newFull = buildNew(nq5m);
  console.log(`${oldFull.strategyName.padEnd(45)} ${summarize(oldFull)}`);
  console.log(`${newFull.strategyName.padEnd(45)} ${summarize(newFull)}`);
  output.fullPeriod = { old: oldFull.stats, new: newFull.stats };

  console.log("\n-- What changed on the 3 previously-flagged hour-16 trades --");
  for (let i = 0; i < oldFull.trades.length; i++) {
    const o = oldFull.trades[i]!;
    const n = newFull.trades[i]!;
    if (o.rMultiple !== n.rMultiple) {
      const bar = nq5m[o.barIndex]!;
      console.log(
        `${nyDateKey(bar.t)} ${String(nyHour(bar.t)).padStart(2, "0")}:${String(nyMinute(bar.t)).padStart(2, "0")} NY entry -- ` +
          `OLD: R=${o.rMultiple.toFixed(2)} (${o.outcome})  ->  NEW: R=${n.rMultiple.toFixed(2)} (${n.outcome}), forced exit @ ${n.exitPrice.toFixed(2)}`,
      );
    }
  }

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 1: Split-period robustness (NEW variant)");
  console.log("=".repeat(105));
  const mid = Math.floor(nq5m.length / 2);
  const h1 = buildNew(nq5m.slice(0, mid));
  const h2 = buildNew(nq5m.slice(mid));
  const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
  console.log(`First half:  ${summarize(h1)}`);
  console.log(`Second half: ${summarize(h2)}`);
  console.log(bothPositive ? "Verdict: POSITIVE in both halves." : "Verdict: NOT positive in both halves.");
  output.splitPeriod = { firstHalf: h1.stats, secondHalf: h2.stats, bothPositive };

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 2: Transaction cost sensitivity (NEW variant)");
  console.log("=".repeat(105));
  const costScenarios = [
    { label: "No cost", usd: 0 },
    { label: "Low-cost (~$5 + 0.5pt slip)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 + 1pt slip)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative (~$10 + 2pt slip)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];
  const costResults: unknown[] = [];
  for (const scenario of costScenarios) {
    const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(newFull.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${scenario.label.padEnd(32)} ($${scenario.usd.toFixed(2)}/trade) totalR=${stats.totalR.toFixed(1).padStart(6)}  finalEquity=$${stats.finalEquity.toFixed(1)}`);
    costResults.push({ ...scenario, totalR: stats.totalR, finalEquity: stats.finalEquity });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES 5-min (NEW variant)");
  console.log("=".repeat(105));
  const oos = buildNew(es5m);
  console.log(summarize(oos));
  output.outOfSample = oos.stats;

  console.log("\n" + "=".repeat(105));
  console.log("Hour-16 breakdown, NEW variant");
  console.log("=".repeat(105));
  const hour16Trades = newFull.trades.filter((t) => nyHour(nq5m[t.barIndex]!.t) === 16);
  const wins = hour16Trades.filter((t) => t.outcome === "win").length;
  console.log(`Hour 16: n=${hour16Trades.length}  wins=${wins}  winRate=${hour16Trades.length > 0 ? ((wins / hour16Trades.length) * 100).toFixed(1) : "n/a"}%  totalR=${hour16Trades.reduce((s, t) => s + t.rMultiple, 0).toFixed(2)}`);

  writeFileSync("data/flagship-lucid-forced-exit-rebuild-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-lucid-forced-exit-rebuild-results.json");
}

main();
