import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import { rollingValueArea, type ValueArea } from "../src/backtest/volumeProfile.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const LOOKBACK_BARS = 100; // ~8.3 hours of 5-min bars -- a rolling intraday-ish profile window

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

type FilterName = "none" | "outsideVA" | "pocTarget" | "both";

function baseSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  return dayHourFilter(bars, merge(meanRev, trend));
}

function applyOutsideVaFilter(signals: Signal[], valueAreas: (ValueArea | null)[]): Signal[] {
  return signals.filter((s) => {
    const va = valueAreas[s.barIndex];
    if (!va) return false;
    // The swept extreme (s.stop) should sit outside the value area, away from "fair value" --
    // i.e. price already extended beyond where volume concentrated before reverting.
    return s.direction === "short" ? s.stop > va.vah : s.stop < va.val;
  });
}

function applyPocTarget(signals: Signal[], valueAreas: (ValueArea | null)[], fallbackR: number, minR: number, maxR: number): Signal[] {
  return signals.map((s) => {
    const va = valueAreas[s.barIndex];
    const risk = Math.abs(s.entry - s.stop);
    if (!va || risk === 0) {
      const target = s.direction === "long" ? s.entry + risk * fallbackR : s.entry - risk * fallbackR;
      return { ...s, target };
    }
    const pocR = Math.abs(va.poc - s.entry) / risk;
    const pocAhead = s.direction === "long" ? va.poc > s.entry : va.poc < s.entry;
    if (pocAhead && pocR >= minR && pocR <= maxR) {
      return { ...s, target: va.poc, reason: s.reason + ` (target=POC, ${pocR.toFixed(2)}R)` };
    }
    const target = s.direction === "long" ? s.entry + risk * fallbackR : s.entry - risk * fallbackR;
    return { ...s, target, reason: s.reason + ` (target=fallback ${fallbackR}R, POC ${pocAhead ? pocR.toFixed(2) + "R out of band" : "behind entry"})` };
  });
}

function build(bars: Bar[], filter: FilterName): StrategyResult {
  const va = rollingValueArea(bars, LOOKBACK_BARS);
  let signals = baseSignals(bars);

  if (filter === "outsideVA") {
    signals = overrideTargetR(applyOutsideVaFilter(signals, va), 5);
  } else if (filter === "pocTarget") {
    signals = applyPocTarget(signals, va, 5, 1, 8);
  } else if (filter === "both") {
    signals = applyPocTarget(applyOutsideVaFilter(signals, va), va, 5, 1, 8);
  } else {
    signals = overrideTargetR(signals, 5);
  }

  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour: 16, deadlineMinute: 45 }); // LucidFlex deadline, representative
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: filter, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const filters: FilterName[] = ["none", "outsideVA", "pocTarget", "both"];
  const labels: Record<FilterName, string> = {
    none: "No volume-profile filter (baseline)",
    outsideVA: "Require swept level OUTSIDE the rolling value area",
    pocTarget: "Target the rolling POC instead of fixed R=5 (1-8R band, fallback R=5)",
    both: "Both: outside-VA entry filter + POC target",
  };

  console.log("=".repeat(110));
  console.log("Volume-profile (rolling POC/VAH/VAL) confluence tests on the flagship strategy");
  console.log("=".repeat(110));
  console.log(`Lookback: ${LOOKBACK_BARS} bars (~8.3h of 5-min data), value area 70% (module defaults).`);
  console.log("Deadline used: LucidFlex's 16:45 NY forced-exit rule (representative, consistent with recent work).\n");

  const fullResults: Record<string, StrategyResult> = {};
  for (const f of filters) {
    const r = build(nq5m, f);
    fullResults[f] = r;
    console.log(`${labels[f].padEnd(58)} ${summarize(r)}`);
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
    console.log(`${labels[f].padEnd(58)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
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
    console.log(`${labels[f].padEnd(58)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ filter: f, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(110));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES 5-min");
  console.log("=".repeat(110));
  const oosResults: unknown[] = [];
  for (const f of filters) {
    const oos = build(es5m, f);
    console.log(`${labels[f].padEnd(58)} ${summarize(oos)}`);
    oosResults.push({ filter: f, ...oos.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/flagship-volume-profile-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-volume-profile-test-results.json");
}

main();
