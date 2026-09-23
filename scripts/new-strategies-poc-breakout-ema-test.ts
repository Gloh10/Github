import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { emaPullback, pocMeanReversion, valueAreaBreakout } from "../src/backtest/strategies.js";
import { rollingValueArea } from "../src/backtest/volumeProfile.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
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
function summarize(result: StrategyResult): string {
  const s = result.stats;
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%`;
}
function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}
function runFull(bars: Bar[], signals: Signal[], label: string): StrategyResult {
  const filtered = dayHourFilter(bars, signals);
  const trades = simulateTradesWithSessionDeadline(bars, filtered, { deadlineHour: 16, deadlineMinute: 45 });
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: label, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

// -- Strategy A: POC mean-reversion (lookback=40, the validated VA lookback)
function buildPoc(bars: Bar[]): StrategyResult {
  const va = rollingValueArea(bars, 40);
  return runFull(bars, pocMeanReversion(bars, va), "POC mean-reversion");
}

// -- Strategy B: value area breakout (lookback=40, targetR=5 for consistency with the flagship)
function buildBreakout(bars: Bar[]): StrategyResult {
  const va = rollingValueArea(bars, 40);
  return runFull(bars, valueAreaBreakout(bars, va, { targetR: 5 }), "Value area breakout");
}

// -- Strategy C: EMA pullback/continuation (21/50, targetR=5, 0.15% touch tolerance)
function buildEmaPullback(bars: Bar[]): StrategyResult {
  return runFull(bars, emaPullback(bars, 21, 50, { targetR: 5, touchTolerancePct: 0.0015 }), "EMA(21/50) pullback");
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const builders: { label: string; fn: (bars: Bar[]) => StrategyResult }[] = [
    { label: "POC mean-reversion", fn: buildPoc },
    { label: "Value area breakout", fn: buildBreakout },
    { label: "EMA(21/50) pullback", fn: buildEmaPullback },
  ];

  console.log("=".repeat(105));
  console.log("THREE NEW STANDALONE STRATEGIES -- full validation battery");
  console.log("=".repeat(105));

  const fullResults: Record<string, StrategyResult> = {};
  for (const b of builders) {
    const r = b.fn(nq5m);
    fullResults[b.label] = r;
    console.log(`${b.label.padEnd(24)} ${summarize(r)}`);
  }
  output.fullPeriod = Object.fromEntries(builders.map((b) => [b.label, fullResults[b.label]!.stats]));

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(105));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const b of builders) {
    const h1 = b.fn(nq5m.slice(0, mid));
    const h2 = b.fn(nq5m.slice(mid));
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${b.label.padEnd(24)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
    splitResults.push({ label: b.label, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 2: Transaction cost sensitivity (conservative scenario)");
  console.log("=".repeat(105));
  const costResults: unknown[] = [];
  for (const b of builders) {
    const full = fullResults[b.label]!;
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${b.label.padEnd(24)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ label: b.label, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES and RTY");
  console.log("=".repeat(105));
  const oosResults: unknown[] = [];
  for (const b of builders) {
    const oosEs = b.fn(es5m);
    const oosRty = b.fn(rty5m);
    console.log(`${b.label}`);
    console.log(`  ES:  ${summarize(oosEs)}`);
    console.log(`  RTY: ${summarize(oosRty)}`);
    oosResults.push({ label: b.label, es: oosEs.stats, rty: oosRty.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/new-strategies-poc-breakout-ema-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/new-strategies-poc-breakout-ema-test-results.json");
}

main();
