import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { valueAreaFade } from "../src/backtest/strategies.js";
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

function build(bars: Bar[], lookback: number, targetMode: "poc" | "oppositeEdge"): StrategyResult {
  const va = rollingValueArea(bars, lookback);
  const signals = dayHourFilter(bars, valueAreaFade(bars, va, { targetMode }));
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour: 16, deadlineMinute: 45 }); // LucidFlex deadline, representative
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: `lookback=${lookback}, target=${targetMode}`, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  console.log("=".repeat(105));
  console.log("NEW STRATEGY: valueAreaFade (previously built, never tested) -- 'failed auction' fade of VAH/VAL");
  console.log("=".repeat(105));
  console.log("Fires when price wicks beyond the value area but closes back inside -- fades toward POC or the opposite edge.\n");

  const configs: { lookback: number; targetMode: "poc" | "oppositeEdge" }[] = [
    { lookback: 40, targetMode: "poc" },
    { lookback: 40, targetMode: "oppositeEdge" },
    { lookback: 100, targetMode: "poc" },
    { lookback: 100, targetMode: "oppositeEdge" },
  ];

  const fullResults: StrategyResult[] = configs.map((c) => build(nq5m, c.lookback, c.targetMode));
  fullResults.forEach((r) => console.log(`${r.strategyName.padEnd(28)} ${summarize(r)}`));
  output.fullPeriod = fullResults.map((r) => ({ label: r.strategyName, ...r.stats }));

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 1: Split-period robustness (every config)");
  console.log("=".repeat(105));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const c of configs) {
    const h1 = build(nq5m.slice(0, mid), c.lookback, c.targetMode);
    const h2 = build(nq5m.slice(mid), c.lookback, c.targetMode);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`lookback=${c.lookback}, target=${c.targetMode}   H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
    splitResults.push({ lookback: c.lookback, targetMode: c.targetMode, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 2: Transaction cost sensitivity (conservative scenario, every config)");
  console.log("=".repeat(105));
  const costResults: unknown[] = [];
  for (let i = 0; i < configs.length; i++) {
    const full = fullResults[i]!;
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${full.strategyName.padEnd(28)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ label: full.strategyName, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES and RTY (every config)");
  console.log("=".repeat(105));
  const oosResults: unknown[] = [];
  for (const c of configs) {
    const oosEs = build(es5m, c.lookback, c.targetMode);
    const oosRty = build(rty5m, c.lookback, c.targetMode);
    console.log(`lookback=${c.lookback}, target=${c.targetMode}`);
    console.log(`  ES:  ${summarize(oosEs)}`);
    console.log(`  RTY: ${summarize(oosRty)}`);
    oosResults.push({ lookback: c.lookback, targetMode: c.targetMode, es: oosEs.stats, rty: oosRty.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/new-strategy-valueAreaFade-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/new-strategy-valueAreaFade-test-results.json");
}

main();
