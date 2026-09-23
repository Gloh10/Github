import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import { rollingValueArea } from "../src/backtest/volumeProfile.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const LOOKBACK = 40;

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
function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}
function summarize(result: StrategyResult): string {
  const s = result.stats;
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%`;
}

function build(bars: Bar[], useFilter: boolean): StrategyResult {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  let signals = dayHourFilter(bars, merge(meanRev, trend));

  if (useFilter) {
    const va = rollingValueArea(bars, LOOKBACK);
    signals = signals.filter((s) => {
      const v = va[s.barIndex];
      if (!v) return false;
      return s.direction === "short" ? s.stop > v.vah : s.stop < v.val;
    });
  }
  signals = overrideTargetR(signals, 5);
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour: 16, deadlineMinute: 45 });
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: useFilter ? `VA filter (lookback=${LOOKBACK})` : "Baseline (no VA filter)", trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString(), lookback: LOOKBACK };

  console.log("=".repeat(105));
  console.log(`FULL VALIDATION -- 'outside value area' filter at lookback=${LOOKBACK} (the robust candidate from the sweep)`);
  console.log("=".repeat(105));

  const baseFull = build(nq5m, false);
  const filtFull = build(nq5m, true);
  console.log(`Baseline:   ${summarize(baseFull)}`);
  console.log(`VA-filtered: ${summarize(filtFull)}`);
  output.fullPeriod = { baseline: baseFull.stats, filtered: filtFull.stats };

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(105));
  const mid = Math.floor(nq5m.length / 2);
  const firstHalf = nq5m.slice(0, mid);
  const secondHalf = nq5m.slice(mid);
  console.log(`First half:  ${new Date(firstHalf[0]!.t * 1000).toISOString().slice(0, 10)} -> ${new Date(firstHalf[firstHalf.length - 1]!.t * 1000).toISOString().slice(0, 10)}`);
  console.log(`Second half: ${new Date(secondHalf[0]!.t * 1000).toISOString().slice(0, 10)} -> ${new Date(secondHalf[secondHalf.length - 1]!.t * 1000).toISOString().slice(0, 10)}\n`);
  for (const [label, useFilter] of [["Baseline", false], ["VA-filtered", true]] as const) {
    const h1 = build(firstHalf, useFilter);
    const h2 = build(secondHalf, useFilter);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${label.padEnd(14)} H1: ${summarize(h1)}`);
    console.log(`${"".padEnd(14)} H2: ${summarize(h2)}   ${bothPositive ? "POSITIVE both halves" : "NOT positive both halves"}`);
    output[`split_${label}`] = { firstHalf: h1.stats, secondHalf: h2.stats, bothPositive };
  }

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 2: Transaction cost sensitivity");
  console.log("=".repeat(105));
  const costScenarios = [
    { label: "No cost", usd: 0 },
    { label: "Low-cost (~$5 + 0.5pt slip)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 + 1pt slip)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative (~$10 + 2pt slip)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];
  for (const [label, useFilter] of [["Baseline", false], ["VA-filtered", true]] as const) {
    const raw = build(nq5m, useFilter);
    console.log(`${label}:`);
    const scenarioResults: unknown[] = [];
    for (const scenario of costScenarios) {
      const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
      const adjusted = applyCost(raw.trades, costPoints);
      const curve = buildEquityCurve(nq5m, adjusted);
      const stats = computeStats(adjusted, curve);
      console.log(`  ${scenario.label.padEnd(32)} ($${scenario.usd.toFixed(2)}/trade) totalR=${stats.totalR.toFixed(1).padStart(6)}`);
      scenarioResults.push({ ...scenario, totalR: stats.totalR });
    }
    output[`cost_${label}`] = scenarioResults;
  }

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on TWO other markets");
  console.log("=".repeat(105));
  for (const [marketLabel, bars] of [["ES", es5m], ["RTY", rty5m]] as const) {
    console.log(`\n-- ${marketLabel} --`);
    const base = build(bars, false);
    const filt = build(bars, true);
    console.log(`  Baseline:    ${summarize(base)}`);
    console.log(`  VA-filtered: ${summarize(filt)}`);
    output[`oos_${marketLabel}`] = { baseline: base.stats, filtered: filt.stats };
  }

  writeFileSync("data/flagship-value-area-lookback40-validation-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-value-area-lookback40-validation-results.json");
}

main();
