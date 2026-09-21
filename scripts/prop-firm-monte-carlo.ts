import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS_PER_ACCOUNT = 1000;

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

interface AccountRule {
  firm: string;
  tier: string;
  accountSize: number;
  profitTarget: number;
  trailingDrawdown: number;
  maxContracts: number;
  consistencyPct: number;
  minTradingDays: number;
}

// Figures pulled from current published rules (Sept 2026).
const ACCOUNTS: AccountRule[] = [
  { firm: "Apex", tier: "25K", accountSize: 25_000, profitTarget: 1_500, trailingDrawdown: 1_500, maxContracts: 4, consistencyPct: 0.5, minTradingDays: 7 },
  { firm: "Apex", tier: "50K", accountSize: 50_000, profitTarget: 3_000, trailingDrawdown: 2_500, maxContracts: 10, consistencyPct: 0.5, minTradingDays: 7 },
  { firm: "Apex", tier: "100K", accountSize: 100_000, profitTarget: 6_000, trailingDrawdown: 3_000, maxContracts: 14, consistencyPct: 0.5, minTradingDays: 7 },
  { firm: "Topstep", tier: "50K", accountSize: 50_000, profitTarget: 3_000, trailingDrawdown: 2_000, maxContracts: 5, consistencyPct: 0.55, minTradingDays: 5 },
  { firm: "Topstep", tier: "100K", accountSize: 100_000, profitTarget: 6_000, trailingDrawdown: 3_000, maxContracts: 10, consistencyPct: 0.55, minTradingDays: 5 },
  { firm: "Topstep", tier: "150K", accountSize: 150_000, profitTarget: 9_000, trailingDrawdown: 4_500, maxContracts: 15, consistencyPct: 0.55, minTradingDays: 5 },
  { firm: "MyFundedFutures", tier: "25K", accountSize: 25_000, profitTarget: 1_500, trailingDrawdown: 1_000, maxContracts: 4, consistencyPct: 0.5, minTradingDays: 2 },
  { firm: "MyFundedFutures", tier: "50K", accountSize: 50_000, profitTarget: 3_000, trailingDrawdown: 2_000, maxContracts: 10, consistencyPct: 0.5, minTradingDays: 2 },
  { firm: "MyFundedFutures", tier: "100K", accountSize: 100_000, profitTarget: 6_000, trailingDrawdown: 3_000, maxContracts: 14, consistencyPct: 0.5, minTradingDays: 2 },
  { firm: "Alpha Futures", tier: "50K", accountSize: 50_000, profitTarget: 4_000, trailingDrawdown: 1_750, maxContracts: 10, consistencyPct: 0.5, minTradingDays: 1 },
  { firm: "Alpha Futures", tier: "100K", accountSize: 100_000, profitTarget: 8_000, trailingDrawdown: 3_500, maxContracts: 14, consistencyPct: 0.5, minTradingDays: 1 },
  { firm: "Alpha Futures", tier: "150K", accountSize: 150_000, profitTarget: 12_000, trailingDrawdown: 5_250, maxContracts: 17, consistencyPct: 0.5, minTradingDays: 1 },
];

function buildBestStrategyTrades(bars: Bar[]): Trade[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const signals = overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);
  return runStrategy("best", bars, signals).trades;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

type Outcome = "PASSED" | "PASSED_BUT_FAILED_CONSISTENCY" | "BUSTED" | "RAN_OUT_OF_DATA";

function runOneTrial(rule: AccountRule, dayBuckets: Trade[][], contracts: number): { outcome: Outcome; dayIndex: number; worstDdPct: number } {
  const shuffledDays = shuffle(dayBuckets);
  let balance = rule.accountSize;
  let peak = rule.accountSize;
  let worstDd = 0;
  const dailyPnL: number[] = [];
  let dayIndex = 0;

  for (const dayTrades of shuffledDays) {
    dayIndex++;
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * NQ_POINT_VALUE_USD * contracts;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      worstDd = Math.max(worstDd, peak - balance);
      if (peak - balance >= rule.trailingDrawdown) {
        return { outcome: "BUSTED", dayIndex, worstDdPct: (worstDd / rule.trailingDrawdown) * 100 };
      }
    }
    dailyPnL.push(dayPnl);

    const totalProfit = balance - rule.accountSize;
    if (totalProfit >= rule.profitTarget && dayIndex >= rule.minTradingDays) {
      const bestDay = Math.max(...dailyPnL);
      const consistencyOk = bestDay <= rule.consistencyPct * totalProfit;
      return {
        outcome: consistencyOk ? "PASSED" : "PASSED_BUT_FAILED_CONSISTENCY",
        dayIndex,
        worstDdPct: (worstDd / rule.trailingDrawdown) * 100,
      };
    }
  }

  return { outcome: "RAN_OUT_OF_DATA", dayIndex, worstDdPct: (worstDd / rule.trailingDrawdown) * 100 };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const trades = buildBestStrategyTrades(nq5m);

  const dayBucketsMap = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(nq5m[t.barIndex]!.t);
    if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
    dayBucketsMap.get(key)!.push(t);
  }
  const dayBuckets = [...dayBucketsMap.values()];
  console.log(`Strategy: 5-min NQ flagship (mean-rev + trend-continuation, R=5, hour+Sunday/Monday filter)`);
  console.log(`${trades.length} trades across ${dayBuckets.length} distinct trading days.`);
  console.log(`Monte Carlo: ${TRIALS_PER_ACCOUNT} trials per account, shuffling the ORDER of trading days (each day's trades stay grouped together) to test path-dependence of the drawdown rules.\n`);

  const avgRiskPoints = trades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / trades.length;

  console.log("=".repeat(100));
  console.log(`Firm / Tier          Contracts  Pass%   FailConsist%  Bust%   RanOut%   AvgDayToPass   AvgWorstDD%`);
  console.log("=".repeat(100));

  const summary: Record<string, unknown>[] = [];
  for (const rule of ACCOUNTS) {
    const targetRiskDollars = rule.trailingDrawdown / 6;
    const sizedContracts = Math.max(1, Math.floor(targetRiskDollars / (avgRiskPoints * NQ_POINT_VALUE_USD)));
    const contracts = Math.min(sizedContracts, rule.maxContracts);

    const outcomes: Outcome[] = [];
    const dayToPass: number[] = [];
    const worstDdPcts: number[] = [];
    for (let trial = 0; trial < TRIALS_PER_ACCOUNT; trial++) {
      const r = runOneTrial(rule, dayBuckets, contracts);
      outcomes.push(r.outcome);
      worstDdPcts.push(r.worstDdPct);
      if (r.outcome === "PASSED" || r.outcome === "PASSED_BUT_FAILED_CONSISTENCY") dayToPass.push(r.dayIndex);
    }

    const pct = (o: Outcome) => (outcomes.filter((x) => x === o).length / TRIALS_PER_ACCOUNT) * 100;
    const avgDayToPass = dayToPass.length > 0 ? dayToPass.reduce((s, v) => s + v, 0) / dayToPass.length : NaN;
    const avgWorstDdPct = worstDdPcts.reduce((s, v) => s + v, 0) / worstDdPcts.length;

    console.log(
      `${(rule.firm + " " + rule.tier).padEnd(21)} ${String(contracts).padStart(9)}  ` +
        `${pct("PASSED").toFixed(1).padStart(5)}%  ${pct("PASSED_BUT_FAILED_CONSISTENCY").toFixed(1).padStart(11)}%  ` +
        `${pct("BUSTED").toFixed(1).padStart(5)}%  ${pct("RAN_OUT_OF_DATA").toFixed(1).padStart(6)}%   ` +
        `${avgDayToPass.toFixed(1).padStart(11)}   ${avgWorstDdPct.toFixed(1).padStart(9)}%`,
    );

    summary.push({
      firm: rule.firm,
      tier: rule.tier,
      contracts,
      passRate: pct("PASSED"),
      failConsistencyRate: pct("PASSED_BUT_FAILED_CONSISTENCY"),
      bustRate: pct("BUSTED"),
      ranOutRate: pct("RAN_OUT_OF_DATA"),
      avgDayToPass,
      avgWorstDdPct,
    });
  }

  writeFileSync("data/prop-firm-monte-carlo-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trialsPerAccount: TRIALS_PER_ACCOUNT, accounts: ACCOUNTS, summary }, null, 2));
  console.log("\nFull results written to data/prop-firm-monte-carlo-results.json");
}

main();
