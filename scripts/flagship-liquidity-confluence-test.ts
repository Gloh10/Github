import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { dailyWickLevels, equalHighsLows, hasLowResistanceRun, isNearLevel, priorDayHighLow } from "../src/backtest/liquidity.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import { findPivots } from "../src/backtest/swings.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TOLERANCE_PCT = 0.0015; // matches the fvgToleranceFraction precedent used elsewhere in this codebase
const PIVOT_CONFIRM = 3;
const MIN_WICK_FRACTION = 0.35;

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

type FilterName = "none" | "eqhl" | "dayHL" | "wicks" | "lrlr" | "any2of4" | "all4";

function buildSignals(bars: Bar[], filter: FilterName): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const filtered = overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);
  if (filter === "none") return filtered;

  const pivots = findPivots(bars, PIVOT_CONFIRM);
  const { highs: eqHighs, lows: eqLows } = equalHighsLows(bars, PIVOT_CONFIRM, TOLERANCE_PCT);
  const priorDayHL = priorDayHighLow(bars);
  const { upperWicks, lowerWicks } = dailyWickLevels(bars, MIN_WICK_FRACTION);

  return filtered.filter((s) => {
    const sweptLevel = s.stop; // for both sub-strategies, stop = the swept wick extreme (bar.h for short, bar.l for long)
    const checks = {
      eqhl: s.direction === "short" ? isNearLevel(sweptLevel, eqHighs, s.barIndex, TOLERANCE_PCT) : isNearLevel(sweptLevel, eqLows, s.barIndex, TOLERANCE_PCT),
      dayHL:
        s.direction === "short"
          ? Math.abs(sweptLevel - priorDayHL[s.barIndex]!.high) / sweptLevel <= TOLERANCE_PCT
          : Math.abs(sweptLevel - priorDayHL[s.barIndex]!.low) / sweptLevel <= TOLERANCE_PCT,
      wicks: s.direction === "short" ? isNearLevel(sweptLevel, upperWicks, s.barIndex, TOLERANCE_PCT) : isNearLevel(sweptLevel, lowerWicks, s.barIndex, TOLERANCE_PCT),
      lrlr: hasLowResistanceRun(pivots, s.barIndex, s.entry, s.target, s.direction),
    };

    if (filter === "eqhl") return checks.eqhl;
    if (filter === "dayHL") return checks.dayHL;
    if (filter === "wicks") return checks.wicks;
    if (filter === "lrlr") return checks.lrlr;
    if (filter === "any2of4") return Object.values(checks).filter(Boolean).length >= 2;
    if (filter === "all4") return checks.eqhl && checks.dayHL && checks.wicks && checks.lrlr;
    return true;
  });
}

function build(bars: Bar[], filter: FilterName): StrategyResult {
  const signals = buildSignals(bars, filter);
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour: 16, deadlineMinute: 45 }); // LucidFlex deadline, representative
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: filter, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const filters: FilterName[] = ["none", "eqhl", "dayHL", "wicks", "lrlr", "any2of4", "all4"];
  const labels: Record<FilterName, string> = {
    none: "No liquidity filter (baseline)",
    eqhl: "Equal highs/lows confluence required",
    dayHL: "Prior-day high/low confluence required",
    wicks: "Daily-wick-level confluence required",
    lrlr: "LRLR (clear run to target) required",
    any2of4: "Any 2-of-4 confluences required",
    all4: "All 4 confluences required",
  };

  console.log("=".repeat(110));
  console.log("Liquidity confluence filters on the flagship strategy (all four requested concepts, tested individually + combined)");
  console.log("=".repeat(110));
  console.log(`Tolerance: ${(TOLERANCE_PCT * 100).toFixed(2)}%, pivot confirm: ${PIVOT_CONFIRM} bars, min wick fraction: ${MIN_WICK_FRACTION}`);
  console.log("Deadline used: LucidFlex's 16:45 NY forced-exit rule (representative, consistent with recent work).\n");

  const fullResults: Record<string, StrategyResult> = {};
  for (const f of filters) {
    const r = build(nq5m, f);
    fullResults[f] = r;
    console.log(`${labels[f].padEnd(42)} ${summarize(r)}`);
  }
  output.fullPeriod = Object.fromEntries(filters.map((f) => [f, fullResults[f]!.stats]));

  console.log("\n" + "=".repeat(110));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(110));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const f of filters) {
    const h1 = build(nq5m.slice(0, mid), f);
    const h2 = build(nq5m.slice(mid), f);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${labels[f].padEnd(42)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
    splitResults.push({ filter: f, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(110));
  console.log("CHECK 2: Transaction cost sensitivity (conservative scenario)");
  console.log("=".repeat(110));
  const costResults: unknown[] = [];
  for (const f of filters) {
    const full = fullResults[f]!;
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${labels[f].padEnd(42)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ filter: f, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(110));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES 5-min");
  console.log("=".repeat(110));
  const oosResults: unknown[] = [];
  for (const f of filters) {
    const oos = build(es5m, f);
    console.log(`${labels[f].padEnd(42)} ${summarize(oos)}`);
    oosResults.push({ filter: f, ...oos.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/flagship-liquidity-confluence-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-liquidity-confluence-test-results.json");
}

main();
