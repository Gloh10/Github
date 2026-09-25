import { readFileSync, writeFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey } from "../src/backtest/nyTime.js";
import { buildFlagshipSignals } from "../src/backtest/strategies.js";
import type { Bar, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 1000;

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
function buildDayBuckets(bars: Bar[], trades: Trade[]): Trade[][] {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(bars[t.barIndex]!.t);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.values()];
}

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const baseSignals = buildFlagshipSignals(nq5m, vwap);

// MyFundedFutures: auto-flatten at 4:10pm ET (verified via search).
const mffTrades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 10 });
const mffDayBuckets = buildDayBuckets(nq5m, mffTrades);

// Apex 4.0: flat by 4:59pm ET, overnight banned on all account types (verified via search).
const apexTrades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 59 });
const apexDayBuckets = buildDayBuckets(nq5m, apexTrades);

const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const CONTRACTS = 1;
const POINT_VALUE = NQ_POINT_VALUE_USD;

interface TrialResult {
  busted: boolean;
  clearedCombine: boolean;
  payoutCount: number;
  totalProtected: number;
}

// -- MyFundedFutures Pro 150K: eval $9,000/$4,600 DD/no consistency, funded ~10-trading-day
// cycles (approximating the real 14-calendar-day window), 80% split, no per-request cap.
const MFF_PRO_DD = 4_600;
const MFF_PRO_MIN_EVAL_DAYS = 2;
const MFF_PRO_CYCLE_TRADING_DAYS = 10;
const MFF_PRO_SPLIT = 0.8;

function runMffProTrial(shuffled: Trade[][]): TrialResult {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let inCombine = true;
  let combineDays = 0;
  let cycleStart = ACCOUNT_SIZE;
  let cycleDays = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * POINT_VALUE * CONTRACTS;
      balance += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= MFF_PRO_DD) return { busted: true, clearedCombine, payoutCount, totalProtected };
    }
    if (inCombine) {
      combineDays++;
      const totalProfit = balance - ACCOUNT_SIZE;
      if (totalProfit >= COMBINE_TARGET && combineDays >= MFF_PRO_MIN_EVAL_DAYS) {
        inCombine = false;
        clearedCombine = true;
        cycleStart = balance;
        peak = balance;
      }
      continue;
    }
    cycleDays++;
    const cycleProfit = balance - cycleStart;
    if (cycleDays >= MFF_PRO_CYCLE_TRADING_DAYS && cycleProfit > 0) {
      const payoutAmount = MFF_PRO_SPLIT * cycleProfit;
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStart = balance;
      cycleDays = 0;
      peak = balance;
    }
  }
  return { busted: false, clearedCombine, payoutCount, totalProtected };
}

// -- Apex 150K: eval $9,000 target, $5,000 DD locking at safety net (accountSize+DD+$100),
// no consistency in eval; PA/funded: 6-step payout ladder, 5 qualifying days, $500 min, 50% consistency.
const APEX_DD = 5_000;
const APEX_LADDER_CAPS = [2_500, 3_000, 3_000, 3_000, 4_000, 5_000];
const APEX_MIN_DAYS = 5;
const APEX_MIN_PROFIT = 500;
const APEX_CONSISTENCY_PCT = 0.5;

function runApexTrial(shuffled: Trade[][]): TrialResult {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - APEX_DD;
  let locked = false;
  let inCombine = true;
  let combineDays = 0;
  let cycleStart = ACCOUNT_SIZE;
  let cycleDailyPnL: number[] = [];
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * POINT_VALUE * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      if (balance < floor) return { busted: true, clearedCombine, payoutCount, totalProtected };
      if (!locked) {
        if (peak >= ACCOUNT_SIZE + APEX_DD + 100) {
          locked = true;
          floor = ACCOUNT_SIZE + 100;
        } else {
          floor = Math.max(floor, peak - APEX_DD);
        }
      }
    }
    if (inCombine) {
      combineDays++;
      const totalProfit = balance - ACCOUNT_SIZE;
      if (totalProfit >= COMBINE_TARGET && combineDays >= 1) {
        inCombine = false;
        clearedCombine = true;
        cycleStart = balance;
      }
      continue;
    }
    cycleDailyPnL.push(dayPnl);
    const cycleProfit = balance - cycleStart;
    const daysOk = cycleDailyPnL.length >= APEX_MIN_DAYS;
    const bestDay = Math.max(...cycleDailyPnL);
    const consistencyOk = cycleProfit <= 0 || bestDay <= APEX_CONSISTENCY_PCT * cycleProfit;
    if (daysOk && cycleProfit >= APEX_MIN_PROFIT && consistencyOk) {
      const cap = APEX_LADDER_CAPS[Math.min(payoutCount, APEX_LADDER_CAPS.length - 1)]!;
      const payoutAmount = Math.min(cap, cycleProfit);
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStart = balance;
      cycleDailyPnL = [];
    }
  }
  return { busted: false, clearedCombine, payoutCount, totalProtected };
}

function report(label: string, results: TrialResult[], oldNote: string) {
  const busted = results.filter((r) => r.busted);
  const cleared = results.filter((r) => r.clearedCombine);
  const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
  const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
  console.log("-".repeat(100));
  console.log(label);
  console.log("-".repeat(100));
  console.log(`Cleared combine: ${((cleared.length / results.length) * 100).toFixed(1)}%   Busted: ${((busted.length / results.length) * 100).toFixed(1)}%`);
  console.log(`Avg payouts: ${avgPayouts.toFixed(2)}   Expected total protected: $${avgProtected.toFixed(0)}`);
  console.log(`FOR COMPARISON -- ${oldNote}\n`);
  return { clearRate: (cleared.length / results.length) * 100, bustRate: (busted.length / results.length) * 100, avgPayouts, avgProtected };
}

function main() {
  console.log("=".repeat(100));
  console.log("MyFundedFutures Pro & Apex 150K -- rebuilt with each firm's OWN verified flat-by deadline");
  console.log("=".repeat(100));
  console.log(`MyFundedFutures: auto-flatten 4:10pm ET -- ${mffTrades.length} trades across ${mffDayBuckets.length} days`);
  console.log(`Apex 4.0: flat by 4:59pm ET, overnight banned -- ${apexTrades.length} trades across ${apexDayBuckets.length} days\n`);

  const mffShuffled: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) mffShuffled.push(shuffle(mffDayBuckets));
  const mffResults = mffShuffled.map(runMffProTrial);
  const mffSummary = report("MyFundedFutures Pro 150K (realistic)", mffResults, "old (unrealistic) numbers: bust 1.6%, avg payouts 0.72, expected $7,063");

  const apexShuffled: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) apexShuffled.push(shuffle(apexDayBuckets));
  const apexResults = apexShuffled.map(runApexTrial);
  const apexSummary = report("Apex Trader Funding 150K (realistic)", apexResults, "old (unrealistic) numbers: bust 0.2%, avg payouts 1.11, expected $2,826");

  writeFileSync(
    "data/mff-pro-apex-realistic-rebuild-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, mffPro: mffSummary, apex: apexSummary }, null, 2),
  );
  console.log("Full results written to data/mff-pro-apex-realistic-rebuild-results.json");
}

main();
