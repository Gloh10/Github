import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
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
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%`;
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
  return dayHourFilter(bars, merge(meanRev, trend));
}

// "Volume bubble" confirmation: the signal's own entry bar must have volume at least
// `multiple` times its trailing `lookback`-bar average -- a disproportionately large single
// print/bar, the mechanical proxy for TradingView's volume-bubble visualization (bars/price
// levels flagged for unusually large volume), read here as exhaustion/climax confirmation on
// the reversal candle itself.
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

type ConfigName = "baseline" | "spike1_5x" | "spike2x" | "spike3x" | "quiet0_5x";

function build(bars: Bar[], config: ConfigName): StrategyResult {
  let signals = baseSignals(bars);
  if (config !== "baseline") {
    const avgVol = avgVolume(bars, 20);
    const multiple = config === "spike1_5x" ? 1.5 : config === "spike2x" ? 2 : config === "spike3x" ? 3 : 0.5;
    signals = signals.filter((s) => {
      const avg = avgVol[s.barIndex]!;
      if (isNaN(avg) || avg === 0) return false;
      const ratio = bars[s.barIndex]!.v / avg;
      return config === "quiet0_5x" ? ratio <= multiple : ratio >= multiple;
    });
  }
  signals = overrideTargetR(signals, 5);
  const trades = simulateTradesWithSessionDeadline(bars, signals, DEADLINE);
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: config, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const configs: ConfigName[] = ["baseline", "spike1_5x", "spike2x", "spike3x", "quiet0_5x"];
  const labels: Record<ConfigName, string> = {
    baseline: "Baseline (no volume filter)",
    spike1_5x: "Require entry-bar volume >= 1.5x its 20-bar average",
    spike2x: "Require entry-bar volume >= 2x its 20-bar average",
    spike3x: "Require entry-bar volume >= 3x its 20-bar average",
    quiet0_5x: "INVERSE: require entry-bar volume <= 0.5x its 20-bar average (low-volume/quiet reversal)",
  };

  console.log("=".repeat(115));
  console.log("Volume-spike ('volume bubble') confirmation on the reversal candle -- flagship strategy");
  console.log("=".repeat(115));

  const fullResults: Record<string, StrategyResult> = {};
  for (const c of configs) {
    const r = build(nq5m, c);
    fullResults[c] = r;
    console.log(`${labels[c].padEnd(66)} ${summarize(r)}`);
  }
  output.fullPeriod = Object.fromEntries(configs.map((c) => [c, fullResults[c]!.stats]));

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(115));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const c of configs) {
    const h1 = build(nq5m.slice(0, mid), c);
    const h2 = build(nq5m.slice(mid), c);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${labels[c].padEnd(66)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
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
    console.log(`${labels[c].padEnd(66)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
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

  writeFileSync("data/flagship-volume-spike-confirmation-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-volume-spike-confirmation-test-results.json");
}

main();
