import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 1000;
const ACCOUNT_SIZE = 150_000;
const PRE_PAYOUT_MLL = 4_500;
const CONTRACTS = 1;
const STANDARD_PAYOUT_CAP = 10_000;
const CONSISTENCY_PAYOUT_CAP = 12_000;
const STANDARD_WIN_DAY_THRESHOLD = 150;
const STANDARD_WIN_DAYS_NEEDED = 5;
const CONSISTENCY_MIN_DAYS = 3;
const CONSISTENCY_PCT = 0.4;
const MAX_PAYOUT_FRACTION = 0.5; // the rule's actual max: 50% of profit-since-last-payout, up to the cap

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

interface TrialResult {
  busted: boolean;
  bustDay: number | null;
  payoutCount: number;
  totalProtected: number;
  finalBalance: number; // balance remaining in the account at the end (0 if busted)
  ranOutOfData: boolean;
}

/**
 * Front-loaded withdrawals: takes the maximum allowed payout (50% of profit
 * earned since the last payout, capped) the INSTANT each new cycle
 * re-qualifies. Each payout resets the floor to the new balance ("maintain
 * your balance between payouts") and restarts the winning-day / consistency
 * counters for the next cycle, per Topstep's published mechanics.
 */
function runOneTrial(shuffled: Trade[][], path: "standard" | "consistency"): TrialResult {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let floor = -Infinity; // -Infinity = still in the pre-first-payout trailing-MLL phase
  let payoutTaken = false; // has the FIRST payout happened (switches MLL mechanics)?
  let winningDaysThisCycle = 0;
  const dailyPnLThisCycle: number[] = [];
  let cycleStartBalance = ACCOUNT_SIZE;
  let payoutCount = 0;
  let totalProtected = 0;
  let dayIndex = 0;

  for (const dayTrades of shuffled) {
    dayIndex++;
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * NQ_POINT_VALUE_USD * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);

      if (!payoutTaken) {
        if (peak - balance >= PRE_PAYOUT_MLL) {
          return { busted: true, bustDay: dayIndex, payoutCount, totalProtected, finalBalance: 0, ranOutOfData: false };
        }
      } else {
        if (balance < floor) {
          return { busted: true, bustDay: dayIndex, payoutCount, totalProtected, finalBalance: 0, ranOutOfData: false };
        }
      }
    }

    if (dayPnl >= STANDARD_WIN_DAY_THRESHOLD) winningDaysThisCycle++;
    dailyPnLThisCycle.push(dayPnl);

    const cycleProfit = balance - cycleStartBalance;
    const standardEligible = winningDaysThisCycle >= STANDARD_WIN_DAYS_NEEDED;
    let consistencyEligible = false;
    if (dailyPnLThisCycle.length >= CONSISTENCY_MIN_DAYS && cycleProfit > 0) {
      const bestDay = Math.max(...dailyPnLThisCycle);
      consistencyEligible = bestDay <= CONSISTENCY_PCT * cycleProfit;
    }
    const eligibleNow = path === "standard" ? standardEligible : consistencyEligible;

    if (eligibleNow && cycleProfit > 0) {
      const cap = path === "standard" ? STANDARD_PAYOUT_CAP : CONSISTENCY_PAYOUT_CAP;
      const payoutAmount = Math.min(cap, MAX_PAYOUT_FRACTION * cycleProfit);
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      floor = balance; // resets to $0 buffer at the NEW balance -- "maintain your balance between payouts"
      payoutTaken = true;
      cycleStartBalance = balance;
      winningDaysThisCycle = 0;
      dailyPnLThisCycle.length = 0;
    }
  }

  return { busted: false, bustDay: null, payoutCount, totalProtected, finalBalance: balance - ACCOUNT_SIZE, ranOutOfData: true };
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

  console.log(`Front-loaded withdrawals: take the max allowed payout (50% of cycle profit, capped) the instant each cycle re-qualifies, repeated as many times as the sample allows.`);
  console.log(`Each payout resets the floor to the new balance and restarts the winning-day/consistency counters for the next cycle.`);
  console.log(`CAVEAT: still bounded by the same 18 historical trading days (proxy for future days) -- multi-cycle results are limited by how much data is available, not just the strategy.\n`);

  for (const path of ["standard", "consistency"] as const) {
    const results: TrialResult[] = [];
    for (let i = 0; i < TRIALS; i++) results.push(runOneTrial(shuffle(dayBuckets), path));

    const busted = results.filter((r) => r.busted);
    const survived = results.filter((r) => !r.busted);
    const avgProtectedOverall = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgProtectedBusted = busted.length > 0 ? busted.reduce((s, r) => s + r.totalProtected, 0) / busted.length : NaN;
    const avgProtectedSurvived = survived.length > 0 ? survived.reduce((s, r) => s + r.totalProtected, 0) / survived.length : NaN;
    const avgPayoutCountBusted = busted.length > 0 ? busted.reduce((s, r) => s + r.payoutCount, 0) / busted.length : NaN;
    const avgPayoutCountSurvived = survived.length > 0 ? survived.reduce((s, r) => s + r.payoutCount, 0) / survived.length : NaN;
    const zeroPayoutBusts = busted.filter((r) => r.payoutCount === 0).length;

    console.log("=".repeat(95));
    console.log(`PATH: ${path.toUpperCase()}`);
    console.log("=".repeat(95));
    console.log(`Bust rate: ${((busted.length / TRIALS) * 100).toFixed(1)}%   Survived-to-end-of-data rate: ${((survived.length / TRIALS) * 100).toFixed(1)}%`);
    console.log(`Average total protected (all trials, busted or not): $${avgProtectedOverall.toFixed(0)}`);
    console.log(`  Among BUSTED trials:   avg protected=$${avgProtectedBusted.toFixed(0)}, avg payouts taken=${avgPayoutCountBusted.toFixed(2)}, busted with $0 EVER protected=${zeroPayoutBusts}/${busted.length} (${((zeroPayoutBusts / busted.length) * 100).toFixed(1)}%)`);
    console.log(`  Among SURVIVING trials: avg protected=$${avgProtectedSurvived.toFixed(0)}, avg payouts taken=${avgPayoutCountSurvived.toFixed(2)}, avg remaining account profit=$${(survived.reduce((s, r) => s + r.finalBalance, 0) / survived.length).toFixed(0)}`);
    console.log("");
  }

  writeFileSync("data/topstep-150k-frontload-payouts-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS }, null, 2));
  console.log("Full run complete.");
}

main();
