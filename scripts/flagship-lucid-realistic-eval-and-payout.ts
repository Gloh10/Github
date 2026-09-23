import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const EVAL_TRIALS = 1000;
const DEPTH_TRIALS = 5000;

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
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// -- Build the LucidFlex-realistic flagship trade set (4:45pm ET forced exit).
const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const signals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const trades = simulateTradesWithSessionDeadline(nq5m, signals, { deadlineHour: 16, deadlineMinute: 45 });

const dayBucketsMap = new Map<string, Trade[]>();
for (const t of trades) {
  const key = nyDateKey(nq5m[t.barIndex]!.t);
  if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
  dayBucketsMap.get(key)!.push(t);
}
const dayBuckets = [...dayBucketsMap.values()];

const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500;
const EVAL_CONSISTENCY_PCT = 0.5;
const CONTRACTS = 1;
const POINT_VALUE = NQ_POINT_VALUE_USD;

// ---------------------------------------------------------------------------
// PART 1: eval-clearing check (same methodology as flagship-lucidflex-eval-check.ts)
// ---------------------------------------------------------------------------
interface EvalResult {
  status: "cleared" | "busted" | "ran_out_of_data";
  dayIndex: number;
}
function runEvalTrial(shuffled: Trade[][]): EvalResult {
  let balance = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let combineDays = 0;
  const combineDailyPnL: number[] = [];
  let dayIndex = 0;

  for (const dayTrades of shuffled) {
    dayIndex++;
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * POINT_VALUE * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", dayIndex };
    }
    if (!locked) {
      if (balance > ACCOUNT_SIZE + DD_AMOUNT + 100) {
        locked = true;
        floor = ACCOUNT_SIZE + 100;
      } else {
        floor = Math.max(floor, balance - DD_AMOUNT);
      }
    }
    combineDays++;
    combineDailyPnL.push(dayPnl);
    const totalProfit = balance - ACCOUNT_SIZE;
    const bestDay = Math.max(...combineDailyPnL);
    const consistencyOk = totalProfit <= 0 || bestDay <= EVAL_CONSISTENCY_PCT * totalProfit;
    if (totalProfit >= COMBINE_TARGET && combineDays >= 1 && consistencyOk) return { status: "cleared", dayIndex };
  }
  return { status: "ran_out_of_data", dayIndex };
}

// ---------------------------------------------------------------------------
// PART 2: payout-depth check (same methodology as lucidflex-150k-payout-depth.ts)
// ---------------------------------------------------------------------------
const PAYOUT_CAP = 3_000;
const WINNING_DAY_THRESHOLD = 250;
const WINNING_DAYS_NEEDED = 5;
const MIN_PAYOUT = 500;
const MAX_PAYOUTS_ON_FLEX = 5;

interface DepthResult {
  status: "busted" | "ran_out_of_data" | "graduated";
  payoutCount: number;
  totalProtected: number;
}
function runDepthTrial(shuffled: Trade[][]): DepthResult {
  let balance = ACCOUNT_SIZE;
  let inCombine = true;
  let phaseAnchor = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let combineDays = 0;
  const combineDailyPnL: number[] = [];
  let cycleStart = ACCOUNT_SIZE;
  let winningDaysThisCycle = 0;
  let payoutCount = 0;
  let totalProtected = 0;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * POINT_VALUE * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", payoutCount, totalProtected };
    }
    if (!locked) {
      if (balance > phaseAnchor + DD_AMOUNT + 100) {
        locked = true;
        floor = phaseAnchor + 100;
      } else {
        floor = Math.max(floor, balance - DD_AMOUNT);
      }
    }

    if (inCombine) {
      combineDays++;
      combineDailyPnL.push(dayPnl);
      const totalProfit = balance - ACCOUNT_SIZE;
      const bestDay = Math.max(...combineDailyPnL);
      const consistencyOk = totalProfit <= 0 || bestDay <= EVAL_CONSISTENCY_PCT * totalProfit;
      if (totalProfit >= COMBINE_TARGET && combineDays >= 1 && consistencyOk) {
        inCombine = false;
        cycleStart = balance;
        phaseAnchor = balance;
        floor = balance - DD_AMOUNT;
        locked = false;
      }
      continue;
    }

    if (dayPnl >= WINNING_DAY_THRESHOLD) winningDaysThisCycle++;
    const cycleProfit = balance - cycleStart;
    if (winningDaysThisCycle >= WINNING_DAYS_NEEDED && cycleProfit > 0) {
      const raw = Math.min(PAYOUT_CAP, 0.5 * balance);
      const payoutAmount = Math.min(raw, cycleProfit);
      if (payoutAmount >= MIN_PAYOUT) {
        balance -= payoutAmount;
        totalProtected += payoutAmount;
        payoutCount++;
        if (payoutCount >= MAX_PAYOUTS_ON_FLEX) return { status: "graduated", payoutCount, totalProtected };
        cycleStart = balance;
        winningDaysThisCycle = 0;
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - DD_AMOUNT;
        }
      }
    }
  }
  return { status: "ran_out_of_data", payoutCount, totalProtected };
}

function main() {
  console.log("=".repeat(100));
  console.log("LucidFlex 150K -- rerun with the REALISTIC flagship trade set (4:45pm ET forced exit)");
  console.log("=".repeat(100));
  console.log(`Underlying: ${trades.length} trades across ${dayBuckets.length} distinct NY trading days\n`);

  console.log("-".repeat(100));
  console.log("PART 1: Eval-clearing check");
  console.log("-".repeat(100));
  const evalResults: EvalResult[] = [];
  for (let i = 0; i < EVAL_TRIALS; i++) evalResults.push(runEvalTrial(shuffle(dayBuckets)));
  const cleared = evalResults.filter((r) => r.status === "cleared");
  const busted = evalResults.filter((r) => r.status === "busted");
  const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;
  console.log(`Cleared: ${((cleared.length / EVAL_TRIALS) * 100).toFixed(1)}%   Busted: ${((busted.length / EVAL_TRIALS) * 100).toFixed(1)}%   Avg days to clear: ${avgDaysToClear.toFixed(1)} of ${dayBuckets.length}`);
  console.log(`FOR COMPARISON -- old (unrealistic) numbers: 99.9% clear, 0.1% bust, avg 6.9 of 18 days\n`);

  console.log("-".repeat(100));
  console.log("PART 2: Payout-depth check (front-loaded withdrawals)");
  console.log("-".repeat(100));
  const depthResults: DepthResult[] = [];
  for (let i = 0; i < DEPTH_TRIALS; i++) depthResults.push(runDepthTrial(shuffle(dayBuckets)));
  const depthBusted = depthResults.filter((r) => r.status === "busted");
  const depthGraduated = depthResults.filter((r) => r.status === "graduated");
  const avgProtected = depthResults.reduce((s, r) => s + r.totalProtected, 0) / depthResults.length;
  const avgPayouts = depthResults.reduce((s, r) => s + r.payoutCount, 0) / depthResults.length;
  const pAtLeastOne = (depthResults.filter((r) => r.payoutCount >= 1).length / DEPTH_TRIALS) * 100;

  console.log(`Busted: ${((depthBusted.length / DEPTH_TRIALS) * 100).toFixed(1)}%   Graduated (5-payout cap): ${((depthGraduated.length / DEPTH_TRIALS) * 100).toFixed(1)}%`);
  console.log(`Avg payouts landed: ${avgPayouts.toFixed(2)}   P(at least 1 payout): ${pAtLeastOne.toFixed(1)}%`);
  console.log(`Expected total protected (all trials): $${avgProtected.toFixed(0)}`);
  console.log(`FOR COMPARISON -- old (unrealistic) numbers: avg 0.99 payouts, 98.9% P(>=1), $2,966 expected\n`);

  console.log("-- Payout-count distribution --");
  for (let n = 0; n <= MAX_PAYOUTS_ON_FLEX; n++) {
    const atN = depthResults.filter((r) => r.payoutCount === n);
    console.log(`  ${n} payout(s): ${((atN.length / DEPTH_TRIALS) * 100).toFixed(1)}%`);
  }

  writeFileSync(
    "data/flagship-lucid-realistic-eval-and-payout-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        evalTrials: EVAL_TRIALS,
        depthTrials: DEPTH_TRIALS,
        distinctDays: dayBuckets.length,
        eval: { clearRate: (cleared.length / EVAL_TRIALS) * 100, bustRate: (busted.length / EVAL_TRIALS) * 100, avgDaysToClear },
        payout: { bustRate: (depthBusted.length / DEPTH_TRIALS) * 100, graduatedRate: (depthGraduated.length / DEPTH_TRIALS) * 100, avgPayouts, pAtLeastOne, avgProtected },
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/flagship-lucid-realistic-eval-and-payout-results.json");
}

main();
