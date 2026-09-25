import { readFileSync, writeFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 1000;
const DEPTH_TRIALS = 5000;

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
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
function buildDayBuckets(bars: Bar[], trades: Trade[]): Trade[][] {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(bars[t.barIndex]!.t);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.values()];
}
function pnlOf(t: Trade): number {
  const riskPoints = Math.abs(t.entry - t.stop);
  return t.rMultiple * riskPoints * NQ_POINT_VALUE_USD;
}

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const baseSignals = overrideTargetR(dayHourFilter(nq5m, meanRev), 5);

const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;

// ============================= LucidFlex 150K =============================
{
  const trades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 45 });
  const dayBuckets = buildDayBuckets(nq5m, trades);
  const DD = 4_500;
  const CONSISTENCY = 0.5;

  interface EvalResult { status: "cleared" | "busted" | "ran_out_of_data"; dayIndex: number; }
  function runEval(shuffled: Trade[][]): EvalResult {
    let balance = ACCOUNT_SIZE, floor = ACCOUNT_SIZE - DD, locked = false, days = 0;
    const dailyPnL: number[] = [];
    for (const dayTrades of shuffled) {
      days++;
      let dayPnl = 0;
      for (const t of dayTrades) { const pnl = pnlOf(t); balance += pnl; dayPnl += pnl; if (balance < floor) return { status: "busted", dayIndex: days }; }
      if (!locked) { if (balance > ACCOUNT_SIZE + DD + 100) { locked = true; floor = ACCOUNT_SIZE + 100; } else floor = Math.max(floor, balance - DD); }
      dailyPnL.push(dayPnl);
      const totalProfit = balance - ACCOUNT_SIZE;
      const bestDay = Math.max(...dailyPnL);
      const consistencyOk = totalProfit <= 0 || bestDay <= CONSISTENCY * totalProfit;
      if (totalProfit >= COMBINE_TARGET && consistencyOk) return { status: "cleared", dayIndex: days };
    }
    return { status: "ran_out_of_data", dayIndex: days };
  }

  const PAYOUT_CAP = 3_000, WIN_THRESHOLD = 250, WIN_DAYS_NEEDED = 5, MIN_PAYOUT = 500, MAX_PAYOUTS = 5;
  interface DepthResult { status: string; payoutCount: number; totalProtected: number; }
  function runDepth(shuffled: Trade[][]): DepthResult {
    let balance = ACCOUNT_SIZE, inCombine = true, phaseAnchor = ACCOUNT_SIZE, floor = ACCOUNT_SIZE - DD, locked = false;
    const combineDailyPnL: number[] = [];
    let cycleStart = ACCOUNT_SIZE, winDays = 0, payoutCount = 0, totalProtected = 0;
    for (const dayTrades of shuffled) {
      let dayPnl = 0;
      for (const t of dayTrades) { const pnl = pnlOf(t); balance += pnl; dayPnl += pnl; if (balance < floor) return { status: "busted", payoutCount, totalProtected }; }
      if (!locked) { if (balance > phaseAnchor + DD + 100) { locked = true; floor = phaseAnchor + 100; } else floor = Math.max(floor, balance - DD); }
      if (inCombine) {
        combineDailyPnL.push(dayPnl);
        const totalProfit = balance - ACCOUNT_SIZE;
        const bestDay = Math.max(...combineDailyPnL);
        const consistencyOk = totalProfit <= 0 || bestDay <= CONSISTENCY * totalProfit;
        if (totalProfit >= COMBINE_TARGET && consistencyOk) { inCombine = false; cycleStart = balance; phaseAnchor = balance; floor = balance - DD; locked = false; }
        continue;
      }
      if (dayPnl >= WIN_THRESHOLD) winDays++;
      const cycleProfit = balance - cycleStart;
      if (winDays >= WIN_DAYS_NEEDED && cycleProfit > 0) {
        const raw = Math.min(PAYOUT_CAP, 0.5 * balance);
        const payoutAmount = Math.min(raw, cycleProfit);
        if (payoutAmount >= MIN_PAYOUT) {
          balance -= payoutAmount; totalProtected += payoutAmount; payoutCount++;
          if (payoutCount >= MAX_PAYOUTS) return { status: "graduated", payoutCount, totalProtected };
          cycleStart = balance; winDays = 0;
          if (!locked) { phaseAnchor = balance; floor = balance - DD; }
        }
      }
    }
    return { status: "ran_out_of_data", payoutCount, totalProtected };
  }

  const evalResults = Array.from({ length: TRIALS }, () => runEval(shuffle(dayBuckets)));
  const cleared = evalResults.filter((r) => r.status === "cleared");
  const busted = evalResults.filter((r) => r.status === "busted");
  console.log("-".repeat(100));
  console.log(`LucidFlex 150K (mean-rev only) -- ${trades.length} trades / ${dayBuckets.length} days`);
  console.log("-".repeat(100));
  console.log(`Eval cleared: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   Busted: ${((busted.length / TRIALS) * 100).toFixed(1)}%   FOR COMPARISON baseline: cleared 96.9%, busted 3.1%`);

  const depthResults = Array.from({ length: DEPTH_TRIALS }, () => runDepth(shuffle(dayBuckets)));
  const avgPayouts = depthResults.reduce((s, r) => s + r.payoutCount, 0) / DEPTH_TRIALS;
  const avgProtected = depthResults.reduce((s, r) => s + r.totalProtected, 0) / DEPTH_TRIALS;
  const pAtLeastOne = (depthResults.filter((r) => r.payoutCount >= 1).length / DEPTH_TRIALS) * 100;
  console.log(`Avg payouts: ${avgPayouts.toFixed(2)}   P(>=1 payout): ${pAtLeastOne.toFixed(1)}%   Expected protected: $${avgProtected.toFixed(0)}   FOR COMPARISON baseline: avg 0.59, P>=1 58.7%, $1736\n`);
}

// ============================= MFF Pro & Apex =============================
{
  const mffTrades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 10 });
  const mffDayBuckets = buildDayBuckets(nq5m, mffTrades);
  const apexTrades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 59 });
  const apexDayBuckets = buildDayBuckets(nq5m, apexTrades);

  const MFF_DD = 4_600, MFF_CYCLE_DAYS = 10, MFF_SPLIT = 0.8;
  interface TrialResult { busted: boolean; clearedCombine: boolean; payoutCount: number; totalProtected: number; }
  function runMff(shuffled: Trade[][]): TrialResult {
    let balance = ACCOUNT_SIZE, peak = ACCOUNT_SIZE, inCombine = true, combineDays = 0, cycleStart = ACCOUNT_SIZE, cycleDays = 0, payoutCount = 0, totalProtected = 0, clearedCombine = false;
    for (const dayTrades of shuffled) {
      for (const t of dayTrades) { const pnl = pnlOf(t); balance += pnl; peak = Math.max(peak, balance); if (peak - balance >= MFF_DD) return { busted: true, clearedCombine, payoutCount, totalProtected }; }
      if (inCombine) {
        combineDays++;
        const totalProfit = balance - ACCOUNT_SIZE;
        if (totalProfit >= COMBINE_TARGET && combineDays >= 2) { inCombine = false; clearedCombine = true; cycleStart = balance; peak = balance; }
        continue;
      }
      cycleDays++;
      const cycleProfit = balance - cycleStart;
      if (cycleDays >= MFF_CYCLE_DAYS && cycleProfit > 0) {
        const payoutAmount = MFF_SPLIT * cycleProfit;
        balance -= payoutAmount; totalProtected += payoutAmount; payoutCount++; cycleStart = balance; cycleDays = 0; peak = balance;
      }
    }
    return { busted: false, clearedCombine, payoutCount, totalProtected };
  }

  const APEX_DD = 5_000, APEX_LADDER = [2500, 3000, 3000, 3000, 4000, 5000], APEX_MIN_DAYS = 5, APEX_MIN_PROFIT = 500, APEX_CONSISTENCY = 0.5;
  function runApex(shuffled: Trade[][]): TrialResult {
    let balance = ACCOUNT_SIZE, peak = ACCOUNT_SIZE, floor = ACCOUNT_SIZE - APEX_DD, locked = false, inCombine = true, combineDays = 0, cycleStart = ACCOUNT_SIZE;
    let cycleDailyPnL: number[] = [], payoutCount = 0, totalProtected = 0, clearedCombine = false;
    for (const dayTrades of shuffled) {
      let dayPnl = 0;
      for (const t of dayTrades) {
        const pnl = pnlOf(t); balance += pnl; dayPnl += pnl; peak = Math.max(peak, balance);
        if (balance < floor) return { busted: true, clearedCombine, payoutCount, totalProtected };
        if (!locked) { if (peak >= ACCOUNT_SIZE + APEX_DD + 100) { locked = true; floor = ACCOUNT_SIZE + 100; } else floor = Math.max(floor, peak - APEX_DD); }
      }
      if (inCombine) {
        combineDays++;
        const totalProfit = balance - ACCOUNT_SIZE;
        if (totalProfit >= COMBINE_TARGET) { inCombine = false; clearedCombine = true; cycleStart = balance; }
        continue;
      }
      cycleDailyPnL.push(dayPnl);
      const cycleProfit = balance - cycleStart;
      const daysOk = cycleDailyPnL.length >= APEX_MIN_DAYS;
      const bestDay = Math.max(...cycleDailyPnL);
      const consistencyOk = cycleProfit <= 0 || bestDay <= APEX_CONSISTENCY * cycleProfit;
      if (daysOk && cycleProfit >= APEX_MIN_PROFIT && consistencyOk) {
        const cap = APEX_LADDER[Math.min(payoutCount, APEX_LADDER.length - 1)]!;
        const payoutAmount = Math.min(cap, cycleProfit);
        balance -= payoutAmount; totalProtected += payoutAmount; payoutCount++; cycleStart = balance; cycleDailyPnL = [];
      }
    }
    return { busted: false, clearedCombine, payoutCount, totalProtected };
  }

  console.log("-".repeat(100));
  console.log(`MyFundedFutures Pro 150K (mean-rev only) -- ${mffTrades.length} trades / ${mffDayBuckets.length} days`);
  console.log("-".repeat(100));
  const mffResults = Array.from({ length: TRIALS }, () => runMff(shuffle(mffDayBuckets)));
  const mffCleared = mffResults.filter((r) => r.clearedCombine).length / TRIALS * 100;
  const mffBusted = mffResults.filter((r) => r.busted).length / TRIALS * 100;
  const mffAvgPayouts = mffResults.reduce((s, r) => s + r.payoutCount, 0) / TRIALS;
  const mffAvgProtected = mffResults.reduce((s, r) => s + r.totalProtected, 0) / TRIALS;
  console.log(`Cleared: ${mffCleared.toFixed(1)}%   Busted: ${mffBusted.toFixed(1)}%   Avg payouts: ${mffAvgPayouts.toFixed(2)}   Expected: $${mffAvgProtected.toFixed(0)}   FOR COMPARISON baseline: cleared 91.0%, busted 17.7%, avg 0.58, $2545\n`);

  console.log("-".repeat(100));
  console.log(`Apex 150K (mean-rev only) -- ${apexTrades.length} trades / ${apexDayBuckets.length} days`);
  console.log("-".repeat(100));
  const apexResults = Array.from({ length: TRIALS }, () => runApex(shuffle(apexDayBuckets)));
  const apexCleared = apexResults.filter((r) => r.clearedCombine).length / TRIALS * 100;
  const apexBusted = apexResults.filter((r) => r.busted).length / TRIALS * 100;
  const apexAvgPayouts = apexResults.reduce((s, r) => s + r.payoutCount, 0) / TRIALS;
  const apexAvgProtected = apexResults.reduce((s, r) => s + r.totalProtected, 0) / TRIALS;
  console.log(`Cleared: ${apexCleared.toFixed(1)}%   Busted: ${apexBusted.toFixed(1)}%   Avg payouts: ${apexAvgPayouts.toFixed(2)}   Expected: $${apexAvgProtected.toFixed(0)}   FOR COMPARISON baseline: cleared 97.8%, busted 2.2%, avg 0.98, $2459`);

  writeFileSync(
    "data/meanrev-only-propfirm-check-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), mffPro: { clearRate: mffCleared, bustRate: mffBusted, avgPayouts: mffAvgPayouts, avgProtected: mffAvgProtected }, apex: { clearRate: apexCleared, bustRate: apexBusted, avgPayouts: apexAvgPayouts, avgProtected: apexAvgProtected } }, null, 2),
  );
}
