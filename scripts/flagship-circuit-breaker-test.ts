import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithCircuitBreaker, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const DEADLINE = { deadlineHour: 16, deadlineMinute: 45 }; // LucidFlex, representative

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
  const wins = result.trades.filter((t) => t.outcome === "win").length;
  const longestLossStreak = maxLossStreak(result.trades);
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%  longestLossStreak=${longestLossStreak}`;
}
function maxLossStreak(trades: Trade[]): number {
  let cur = 0,
    max = 0;
  for (const t of trades) {
    if (t.outcome === "loss") {
      cur++;
      max = Math.max(max, cur);
    } else cur = 0;
  }
  return max;
}
function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}

function baseSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  return overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);
}

type ConfigName = "none" | "thresh2_restOfDay" | "thresh3_restOfDay" | "thresh2_fixed24bars" | "thresh2_fixed6bars";

function build(bars: Bar[], config: ConfigName): StrategyResult {
  const signals = baseSignals(bars);
  let trades: Trade[];
  if (config === "none") {
    trades = simulateTradesWithSessionDeadline(bars, signals, DEADLINE);
  } else if (config === "thresh2_restOfDay") {
    trades = simulateTradesWithCircuitBreaker(bars, signals, DEADLINE, { lossStreakThreshold: 2, cooldownMode: "restOfDay" });
  } else if (config === "thresh3_restOfDay") {
    trades = simulateTradesWithCircuitBreaker(bars, signals, DEADLINE, { lossStreakThreshold: 3, cooldownMode: "restOfDay" });
  } else if (config === "thresh2_fixed24bars") {
    trades = simulateTradesWithCircuitBreaker(bars, signals, DEADLINE, { lossStreakThreshold: 2, cooldownMode: "fixedBars", cooldownBars: 24 }); // 2 hours
  } else {
    trades = simulateTradesWithCircuitBreaker(bars, signals, DEADLINE, { lossStreakThreshold: 2, cooldownMode: "fixedBars", cooldownBars: 6 }); // 30 min
  }
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: config, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const configs: ConfigName[] = ["none", "thresh2_restOfDay", "thresh3_restOfDay", "thresh2_fixed24bars", "thresh2_fixed6bars"];
  const labels: Record<ConfigName, string> = {
    none: "No circuit breaker (baseline)",
    thresh2_restOfDay: "Pause after 2 losses, rest of day",
    thresh3_restOfDay: "Pause after 3 losses, rest of day",
    thresh2_fixed24bars: "Pause after 2 losses, fixed 2hr cooldown",
    thresh2_fixed6bars: "Pause after 2 losses, fixed 30min cooldown",
  };

  console.log("=".repeat(115));
  console.log("Circuit breaker test -- asymmetric: caps losing streaks, never caps winning streaks");
  console.log("=".repeat(115));

  const fullResults: Record<string, StrategyResult> = {};
  for (const c of configs) {
    const r = build(nq5m, c);
    fullResults[c] = r;
    console.log(`${labels[c].padEnd(45)} ${summarize(r)}`);
  }
  output.fullPeriod = Object.fromEntries(configs.map((c) => [c, { ...fullResults[c]!.stats, longestLossStreak: maxLossStreak(fullResults[c]!.trades) }]));

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(115));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const c of configs) {
    const h1 = build(nq5m.slice(0, mid), c);
    const h2 = build(nq5m.slice(mid), c);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${labels[c].padEnd(45)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
    splitResults.push({ config: c, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 2: Transaction cost sensitivity (conservative scenario)");
  console.log("=".repeat(115));
  const costResults: unknown[] = [];
  for (const c of configs) {
    const full = fullResults[c]!;
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${labels[c].padEnd(45)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ config: c, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES and RTY");
  console.log("=".repeat(115));
  const oosResults: unknown[] = [];
  for (const c of configs) {
    const oosEs = build(es5m, c);
    const oosRty = build(rty5m, c);
    console.log(`${labels[c]}`);
    console.log(`  ES:  ${summarize(oosEs)}`);
    console.log(`  RTY: ${summarize(oosRty)}`);
    oosResults.push({ config: c, es: oosEs.stats, rty: oosRty.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/flagship-circuit-breaker-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-circuit-breaker-test-results.json");
}

main();
