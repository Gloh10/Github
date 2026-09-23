import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { computeDailyBias, vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
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

type BiasMode = "none" | "permissive" | "strict";

function buildSignals(bars: Bar[], biasMode: BiasMode, sweepReclaimWindowBars: number): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const filtered = overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);

  if (biasMode === "none") return filtered;

  const bias = computeDailyBias(bars, sweepReclaimWindowBars);
  return filtered.filter((s) => {
    const b = bias[s.barIndex]!;
    if (biasMode === "strict") return b !== null && b === s.direction;
    // permissive: trade freely before a bias has formed, only filter once one exists
    return b === null || b === s.direction;
  });
}

function build(bars: Bar[], deadlineHour: number, deadlineMinute: number, biasMode: BiasMode, sweepReclaimWindowBars: number): StrategyResult {
  const signals = buildSignals(bars, biasMode, sweepReclaimWindowBars);
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour, deadlineMinute });
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: biasMode, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  // LucidFlex's deadline (16:45 NY) as the representative firm, consistent with recent work.
  const DEADLINE_HOUR = 16;
  const DEADLINE_MINUTE = 45;
  const SWEEP_RECLAIM_WINDOW = 6; // bars (30 min on 5-min data) -- same order of magnitude as Setup 9's original use

  console.log("=".repeat(105));
  console.log("Daily-bias filter test -- does filtering the flagship's signals by prior-day-sweep bias help?");
  console.log("=".repeat(105));
  console.log("Bias rule: first sweep of the prior NY day's high/low that reclaims within 30 min sets the day's");
  console.log("bias (long/short) for the rest of that day. 'permissive' trades freely before a bias forms and only");
  console.log("filters once one exists; 'strict' only trades once a bias exists.\n");

  const none = build(nq5m, DEADLINE_HOUR, DEADLINE_MINUTE, "none", SWEEP_RECLAIM_WINDOW);
  const permissive = build(nq5m, DEADLINE_HOUR, DEADLINE_MINUTE, "permissive", SWEEP_RECLAIM_WINDOW);
  const strict = build(nq5m, DEADLINE_HOUR, DEADLINE_MINUTE, "strict", SWEEP_RECLAIM_WINDOW);

  console.log(`No bias filter (current baseline)  ${summarize(none)}`);
  console.log(`Permissive bias filter              ${summarize(permissive)}`);
  console.log(`Strict bias filter                  ${summarize(strict)}`);
  output.fullPeriod = { none: none.stats, permissive: permissive.stats, strict: strict.stats };

  // Validate whichever variant looks best.
  const variants: { label: string; mode: BiasMode }[] = [
    { label: "none", mode: "none" },
    { label: "permissive", mode: "permissive" },
    { label: "strict", mode: "strict" },
  ];

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 1: Split-period robustness (every variant)");
  console.log("=".repeat(105));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const v of variants) {
    const h1 = build(nq5m.slice(0, mid), DEADLINE_HOUR, DEADLINE_MINUTE, v.mode, SWEEP_RECLAIM_WINDOW);
    const h2 = build(nq5m.slice(mid), DEADLINE_HOUR, DEADLINE_MINUTE, v.mode, SWEEP_RECLAIM_WINDOW);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${v.label.padEnd(14)} H1: ${summarize(h1)}`);
    console.log(`${"".padEnd(14)} H2: ${summarize(h2)}   ${bothPositive ? "POSITIVE both halves" : "NOT positive both halves"}`);
    splitResults.push({ label: v.label, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 2: Transaction cost sensitivity (every variant, conservative scenario only)");
  console.log("=".repeat(105));
  const costResults: unknown[] = [];
  for (const v of variants) {
    const full = build(nq5m, DEADLINE_HOUR, DEADLINE_MINUTE, v.mode, SWEEP_RECLAIM_WINDOW);
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD; // conservative: ~$50/trade
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${v.label.padEnd(14)} totalR (no cost)=${full.stats.totalR.toFixed(1).padStart(6)}   totalR (conservative cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ label: v.label, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES 5-min (every variant)");
  console.log("=".repeat(105));
  const oosResults: unknown[] = [];
  for (const v of variants) {
    const oos = build(es5m, DEADLINE_HOUR, DEADLINE_MINUTE, v.mode, SWEEP_RECLAIM_WINDOW);
    console.log(`${v.label.padEnd(14)} ${summarize(oos)}`);
    oosResults.push({ label: v.label, ...oos.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/flagship-daily-bias-filter-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-daily-bias-filter-test-results.json");
}

main();
