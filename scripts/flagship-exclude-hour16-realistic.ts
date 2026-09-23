import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];
function dayHourFilter(bars: Bar[], signals: Signal[], excludedHours: number[]): Signal[] {
  return signals.filter((s) => {
    const bar = bars[s.barIndex]!;
    const hour = nyHour(bar.t);
    const weekday = nyWeekday(bar.t);
    if (excludedHours.includes(hour)) return false;
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
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%  $100 -> $${s.finalEquity.toFixed(2)}`;
}

const BASE_EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];

function build(bars: Bar[], deadlineHour: number, deadlineMinute: number, excludeHour16: boolean): StrategyResult {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const excludedHours = excludeHour16 ? [...BASE_EXCLUDED_HOURS, 16] : BASE_EXCLUDED_HOURS;
  const signals = overrideTargetR(dayHourFilter(bars, merge(meanRev, trend), excludedHours), 5);
  const trades = simulateTradesWithSessionDeadline(bars, signals, { deadlineHour, deadlineMinute });
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: excludeHour16 ? "Hour-16 excluded" : "Hour-16 included", trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const firms = [
    { name: "MyFundedFutures", hour: 16, minute: 10 },
    { name: "LucidFlex", hour: 16, minute: 45 },
    { name: "Apex 4.0", hour: 16, minute: 59 },
  ];

  console.log("=".repeat(105));
  console.log("Does excluding hour 16 recover the edge lost to each firm's forced-exit deadline?");
  console.log("=".repeat(105));

  const firmResults: Record<string, unknown> = {};
  for (const firm of firms) {
    console.log(`\n-- ${firm.name} (deadline ${firm.hour}:${String(firm.minute).padStart(2, "0")} NY) --`);
    const withHour16 = build(nq5m, firm.hour, firm.minute, false);
    const without = build(nq5m, firm.hour, firm.minute, true);
    console.log(`  Hour-16 included: ${summarize(withHour16)}`);
    console.log(`  Hour-16 excluded: ${summarize(without)}`);
    firmResults[firm.name] = { withHour16: withHour16.stats, without: without.stats };
  }
  output.byFirm = firmResults;

  // Pick LucidFlex (16:45) as the representative deadline for the deeper validation checks below,
  // since it's the one already established as the primary near-term plan.
  console.log("\n" + "=".repeat(105));
  console.log("VALIDATION (LucidFlex deadline 16:45) -- hour-16-excluded variant");
  console.log("=".repeat(105));

  const mid = Math.floor(nq5m.length / 2);
  const h1 = build(nq5m.slice(0, mid), 16, 45, true);
  const h2 = build(nq5m.slice(mid), 16, 45, true);
  const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
  console.log(`Split-period: H1 ${summarize(h1)}`);
  console.log(`              H2 ${summarize(h2)}   ${bothPositive ? "POSITIVE both halves" : "NOT positive both halves"}`);
  output.splitPeriod = { firstHalf: h1.stats, secondHalf: h2.stats, bothPositive };

  const full = build(nq5m, 16, 45, true);
  console.log("\nTransaction cost sensitivity:");
  const costScenarios = [
    { label: "No cost", usd: 0 },
    { label: "Low-cost (~$5 + 0.5pt slip)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 + 1pt slip)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative (~$10 + 2pt slip)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];
  const costResults: unknown[] = [];
  for (const scenario of costScenarios) {
    const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`  ${scenario.label.padEnd(32)} totalR=${stats.totalR.toFixed(1).padStart(6)}  finalEquity=$${stats.finalEquity.toFixed(1)}`);
    costResults.push({ ...scenario, totalR: stats.totalR, finalEquity: stats.finalEquity });
  }
  output.costResults = costResults;

  const oos = build(es5m, 16, 45, true);
  console.log(`\nOut-of-sample (ES, same rules): ${summarize(oos)}`);
  output.outOfSample = oos.stats;

  writeFileSync("data/flagship-exclude-hour16-realistic-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-exclude-hour16-realistic-results.json");
}

main();
