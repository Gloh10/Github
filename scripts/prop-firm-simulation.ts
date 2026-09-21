import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

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

interface AccountRule {
  firm: string;
  tier: string;
  accountSize: number;
  profitTarget: number;
  trailingDrawdown: number;
  maxContracts: number; // full-size NQ-equivalent contracts allowed
  consistencyPct: number; // best single day's profit must be <= this fraction of TOTAL profit target
  minTradingDays: number;
}

// Figures pulled from current published rules (Sept 2026), EOD-trailing-drawdown variants where firms offer a choice.
const ACCOUNTS: AccountRule[] = [
  { firm: "Apex Trader Funding", tier: "25K", accountSize: 25_000, profitTarget: 1_500, trailingDrawdown: 1_500, maxContracts: 4, consistencyPct: 0.5, minTradingDays: 7 },
  { firm: "Apex Trader Funding", tier: "50K", accountSize: 50_000, profitTarget: 3_000, trailingDrawdown: 2_500, maxContracts: 10, consistencyPct: 0.5, minTradingDays: 7 },
  { firm: "Apex Trader Funding", tier: "100K", accountSize: 100_000, profitTarget: 6_000, trailingDrawdown: 3_000, maxContracts: 14, consistencyPct: 0.5, minTradingDays: 7 },
  { firm: "Topstep", tier: "50K", accountSize: 50_000, profitTarget: 3_000, trailingDrawdown: 2_000, maxContracts: 5, consistencyPct: 0.55, minTradingDays: 5 },
  { firm: "Topstep", tier: "100K", accountSize: 100_000, profitTarget: 6_000, trailingDrawdown: 3_000, maxContracts: 10, consistencyPct: 0.55, minTradingDays: 5 },
  { firm: "Topstep", tier: "150K", accountSize: 150_000, profitTarget: 9_000, trailingDrawdown: 4_500, maxContracts: 15, consistencyPct: 0.55, minTradingDays: 5 },
];

function buildBestStrategyTrades(bars: Bar[]): Trade[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const signals = overrideTargetR(dayHourFilter(bars, merge(meanRev, trend)), 5);
  return runStrategy("best", bars, signals).trades;
}

interface SimResult {
  firm: string;
  tier: string;
  outcome: "PASSED" | "BUSTED" | "RAN_OUT_OF_DATA" | "PASSED_BUT_FAILED_CONSISTENCY";
  onDay: number | null;
  onDate: string | null;
  contracts: number;
  finalBalance: number;
  worstDrawdownHit: number;
  bestSingleDayProfit: number;
  totalProfitAtEnd: number;
  tradingDaysUsed: number;
}

function simulate(rule: AccountRule, bars: Bar[], trades: Trade[]): SimResult {
  // Position sizing: risk per trade sized so the average stop costs about 1/6 of the trailing
  // drawdown (survive a real losing streak), capped at the firm's max allowed contracts.
  const avgRiskPoints = trades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / trades.length;
  const targetRiskDollars = rule.trailingDrawdown / 6;
  const sizedContracts = Math.max(1, Math.floor(targetRiskDollars / (avgRiskPoints * NQ_POINT_VALUE_USD)));
  const contracts = Math.min(sizedContracts, rule.maxContracts);

  let balance = rule.accountSize;
  let peakBalance = rule.accountSize;
  let worstDrawdownHit = 0;
  const dailyPnL = new Map<string, number>();
  const tradingDays = new Set<string>();
  let outcome: SimResult["outcome"] = "RAN_OUT_OF_DATA";
  let onDay: number | null = null;
  let onDate: string | null = null;

  for (const trade of trades) {
    const dateKey = nyDateKey(bars[trade.barIndex]!.t);
    tradingDays.add(dateKey);
    const riskPoints = Math.abs(trade.entry - trade.stop);
    const dollarPnL = trade.rMultiple * riskPoints * NQ_POINT_VALUE_USD * contracts;
    balance += dollarPnL;
    dailyPnL.set(dateKey, (dailyPnL.get(dateKey) ?? 0) + dollarPnL);
    peakBalance = Math.max(peakBalance, balance);
    const ddFromPeak = peakBalance - balance;
    worstDrawdownHit = Math.max(worstDrawdownHit, ddFromPeak);

    if (ddFromPeak >= rule.trailingDrawdown) {
      outcome = "BUSTED";
      onDay = tradingDays.size;
      onDate = dateKey;
      break;
    }

    const totalProfit = balance - rule.accountSize;
    if (totalProfit >= rule.profitTarget && tradingDays.size >= rule.minTradingDays) {
      const bestDay = Math.max(...dailyPnL.values());
      const consistencyOk = bestDay <= rule.consistencyPct * totalProfit;
      outcome = consistencyOk ? "PASSED" : "PASSED_BUT_FAILED_CONSISTENCY";
      onDay = tradingDays.size;
      onDate = dateKey;
      break;
    }
  }

  const bestSingleDayProfit = dailyPnL.size > 0 ? Math.max(...dailyPnL.values()) : 0;
  return {
    firm: rule.firm,
    tier: rule.tier,
    outcome,
    onDay,
    onDate,
    contracts,
    finalBalance: balance,
    worstDrawdownHit,
    bestSingleDayProfit,
    totalProfitAtEnd: balance - rule.accountSize,
    tradingDaysUsed: tradingDays.size,
  };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const trades = buildBestStrategyTrades(nq5m);
  console.log(`Strategy: 5-min NQ, mean-rev + trend-continuation, R=5, hour+Sunday/Monday filter (the flagship result, $100 -> $190.99 normalized)`);
  console.log(`Trade log: ${trades.length} trades\n`);

  console.log("=".repeat(100));
  console.log("Prop firm challenge simulation -- real dollar P&L, real trailing drawdown, real consistency rules");
  console.log("=".repeat(100));

  const results: SimResult[] = [];
  for (const rule of ACCOUNTS) {
    const result = simulate(rule, nq5m, trades);
    results.push(result);
    console.log(
      `${rule.firm.padEnd(22)} ${rule.tier.padEnd(6)} $${rule.accountSize.toLocaleString().padEnd(9)} ` +
        `contracts=${String(result.contracts).padStart(2)}  ${result.outcome.padEnd(28)} ` +
        `day=${String(result.onDay ?? result.tradingDaysUsed).padStart(2)}  ` +
        `finalBalance=$${result.finalBalance.toFixed(0).padStart(9)}  ` +
        `worstDD=$${result.worstDrawdownHit.toFixed(0).padStart(6)} (limit $${rule.trailingDrawdown})  ` +
        `bestDay=$${result.bestSingleDayProfit.toFixed(0)}`,
    );
  }

  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r.outcome === "PASSED").length;
  const failedConsistency = results.filter((r) => r.outcome === "PASSED_BUT_FAILED_CONSISTENCY").length;
  const busted = results.filter((r) => r.outcome === "BUSTED").length;
  console.log(`${passed}/${results.length} cleanly PASSED, ${failedConsistency} hit the profit target but FAILED the consistency rule, ${busted} BUSTED (hit trailing drawdown).`);

  writeFileSync("data/prop-firm-simulation-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), accounts: ACCOUNTS, results }, null, 2));
  console.log("\nFull results written to data/prop-firm-simulation-results.json");
}

main();
