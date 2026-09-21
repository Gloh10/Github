import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const MNQ_POINT_VALUE_USD = 2;
const TRIALS = 1000;

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

// MyFundedFutures (Core plan), all 4 published account tiers. Profit target ~6% of size,
// EOD trailing drawdown ~3% of size. Funded stage: no consistency rule, payout every 5
// winning days (any positive day, per available sources -- no per-day $ threshold found),
// capped at $5,000/cycle, drawdown continues trailing (no stated reset-to-zero, lower
// confidence than Topstep's explicit rule -- see prior analysis).
const TIERS = [
  { tier: "25K", accountSize: 25_000, combineTarget: 1_500, combineMLL: 1_000, maxContractsNQ: 4 },
  { tier: "50K", accountSize: 50_000, combineTarget: 3_000, combineMLL: 2_000, maxContractsNQ: 10 },
  { tier: "100K", accountSize: 100_000, combineTarget: 6_000, combineMLL: 3_000, maxContractsNQ: 14 },
  { tier: "150K", accountSize: 150_000, combineTarget: 9_000, combineMLL: 4_500, maxContractsNQ: 15 },
];
const COMBINE_MIN_DAYS = 2;
const COMBINE_CONSISTENCY_PCT = 0.5;
const WINNING_DAYS_NEEDED = 5;
const PAYOUT_CAP = 5_000;

interface TrialResult {
  busted: boolean;
  payoutCount: number;
  totalProtected: number;
  clearedCombine: boolean;
}

function runOneTrial(shuffled: Trade[][], accountSize: number, combineTarget: number, combineMLL: number, pointValue: number, contracts: number): TrialResult {
  let balance = accountSize;
  let peak = accountSize;
  let inCombine = true;
  const combineDailyPnL: number[] = [];
  let winningDaysThisCycle = 0;
  let cycleStartBalance = accountSize;
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= combineMLL) return { busted: true, payoutCount, totalProtected, clearedCombine };
    }

    if (inCombine) {
      combineDailyPnL.push(dayPnl);
      const totalProfit = balance - accountSize;
      const daysOk = combineDailyPnL.length >= COMBINE_MIN_DAYS;
      const bestDay = Math.max(...combineDailyPnL);
      const consistencyOk = totalProfit <= 0 || bestDay <= COMBINE_CONSISTENCY_PCT * totalProfit;
      if (totalProfit >= combineTarget && daysOk && consistencyOk) {
        inCombine = false;
        clearedCombine = true;
        cycleStartBalance = balance;
        peak = balance;
      }
      continue;
    }

    if (dayPnl > 0) winningDaysThisCycle++;
    const cycleProfit = balance - cycleStartBalance;
    if (winningDaysThisCycle >= WINNING_DAYS_NEEDED && cycleProfit > 0) {
      const payoutAmount = Math.min(PAYOUT_CAP, cycleProfit);
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStartBalance = balance;
      winningDaysThisCycle = 0;
      peak = balance; // trailing DD continues, anchored fresh at the post-payout balance
    }
  }

  return { busted: false, payoutCount, totalProtected, clearedCombine };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const trades = buildBestStrategyTrades(nq5m);
  const avgRiskPoints = trades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / trades.length;

  const dayBucketsMap = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(nq5m[t.barIndex]!.t);
    if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
    dayBucketsMap.get(key)!.push(t);
  }
  const dayBuckets = [...dayBucketsMap.values()];

  console.log(`MyFundedFutures (Core), all 4 tiers, front-loaded withdrawals (max extraction, indifferent to survival).`);
  console.log(`Avg stop distance in the strategy's trade log: ${avgRiskPoints.toFixed(1)} NQ points.\n`);

  const shuffledTrials: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) shuffledTrials.push(shuffle(dayBuckets));

  const summary: { tier: string; instrument: string; contracts: number; avgProtected: number; bustRate: number; clearRate: number; avgPayouts: number; worstDdPctOfBudget: number }[] = [];

  for (const t of TIERS) {
    // Size using NQ first; if 1 contract would eat too much of the combine drawdown budget
    // (the exact problem found earlier for Apex 25K), switch to MNQ micros for finer sizing.
    const oneNqContractRiskPct = (avgRiskPoints * NQ_POINT_VALUE_USD) / t.combineMLL;
    const useMicro = oneNqContractRiskPct > 0.2;
    const pointValue = useMicro ? MNQ_POINT_VALUE_USD : NQ_POINT_VALUE_USD;
    const targetRiskDollars = t.combineMLL / 6;
    const maxContracts = useMicro ? t.maxContractsNQ * 10 : t.maxContractsNQ;
    const contracts = Math.max(1, Math.min(maxContracts, Math.floor(targetRiskDollars / (avgRiskPoints * pointValue))));
    const worstDdPctOfBudget = (avgRiskPoints * pointValue * contracts) / t.combineMLL;

    const results = shuffledTrials.map((s) => runOneTrial(s, t.accountSize, t.combineTarget, t.combineMLL, pointValue, contracts));
    const cleared = results.filter((r) => r.clearedCombine);
    const busted = results.filter((r) => r.busted);
    const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;

    console.log("=".repeat(95));
    console.log(`${t.tier} account ($${t.accountSize.toLocaleString()}) -- sized in ${useMicro ? "MNQ micros" : "NQ full-size"}, ${contracts} contract(s)`);
    console.log("=".repeat(95));
    console.log(`Cleared combine: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   Eventually busted: ${((busted.length / TRIALS) * 100).toFixed(1)}%   Avg payouts: ${avgPayouts.toFixed(2)}`);
    console.log(`Single-contract risk as % of combine DD budget: ${(worstDdPctOfBudget * 100).toFixed(1)}%`);
    console.log(`EXPECTED TOTAL PROTECTED (all trials): $${avgProtected.toFixed(0)}\n`);

    summary.push({ tier: t.tier, instrument: useMicro ? "MNQ" : "NQ", contracts, avgProtected, bustRate: (busted.length / TRIALS) * 100, clearRate: (cleared.length / TRIALS) * 100, avgPayouts, worstDdPctOfBudget: worstDdPctOfBudget * 100 });
  }

  console.log("=".repeat(95));
  console.log("SUMMARY -- all 4 MyFundedFutures tiers");
  console.log("=".repeat(95));
  summary.forEach((s) =>
    console.log(
      `${s.tier.padEnd(6)} ${s.instrument.padEnd(4)} ${String(s.contracts).padStart(3)} contracts   ` +
        `expectedProtected=$${s.avgProtected.toFixed(0).padStart(6)}   bustRate=${s.bustRate.toFixed(1)}%   clearRate=${s.clearRate.toFixed(1)}%   avgPayouts=${s.avgPayouts.toFixed(2)}`,
    ),
  );

  writeFileSync("data/myfundedfutures-all-tiers-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, summary }, null, 2));
  console.log("\nFull results written to data/myfundedfutures-all-tiers-results.json");
}

main();
