import { readFileSync, writeFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 2000;
const VOLUME_MULT = 1.5;
const VOLUME_LOOKBACK = 20;

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
function buildDayBuckets(bars: Bar[], trades: Trade[]): Trade[][] {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(bars[t.barIndex]!.t);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.values()];
}
function avgVolume(bars: Bar[], lookback: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.v;
    if (i >= lookback) sum -= bars[i - lookback]!.v;
    if (i >= lookback - 1) out[i] = sum / lookback;
  }
  return out;
}

function buildVolumeSpikeFilteredTrades(bars: Bar[], deadlineHour: number, deadlineMinute: number): Trade[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  let signals: Signal[] = dayHourFilter(bars, merge(meanRev, trend));

  const avgVol = avgVolume(bars, VOLUME_LOOKBACK);
  signals = signals.filter((s) => {
    const avg = avgVol[s.barIndex]!;
    if (isNaN(avg) || avg === 0) return false;
    return bars[s.barIndex]!.v / avg >= VOLUME_MULT;
  });
  signals = overrideTargetR(signals, 5);
  return simulateTradesWithSessionDeadline(bars, signals, { deadlineHour, deadlineMinute });
}

const nq5m = loadBars("data/nq-5m.json");
const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;

interface FullResult {
  status: "busted" | "ran_out_of_data" | "graduated_or_capped";
  clearedEval: boolean;
  daysToClearEval: number | null;
  payoutCount: number;
  totalProtected: number;
}

// -- LucidFlex 150K: 16:45 deadline, $4,500 DD (locks at safety net), 50% eval consistency,
// funded stage 5 days >= $250, $3,000 cap, min $500, max 5 payouts.
const lucidTrades = buildVolumeSpikeFilteredTrades(nq5m, 16, 45);
const lucidDayBuckets = buildDayBuckets(nq5m, lucidTrades);
const LUCID_DD = 4_500;
const LUCID_CONSISTENCY_PCT = 0.5;
const LUCID_PAYOUT_CAP = 3_000;
const LUCID_WIN_DAY_THRESHOLD = 250;
const LUCID_WINNING_DAYS_NEEDED = 5;
const LUCID_MIN_PAYOUT = 500;
const LUCID_MAX_PAYOUTS = 5;

function runLucidTrial(days: Trade[][]): FullResult {
  let balance = ACCOUNT_SIZE;
  let phaseAnchor = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - LUCID_DD;
  let locked = false;
  let inEval = true;
  let evalDays = 0;
  const evalDailyPnL: number[] = [];
  let clearedEval = false;
  let daysToClearEval: number | null = null;
  let cycleStart = ACCOUNT_SIZE;
  let winningDaysThisCycle = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let dayIndex = 0;

  for (const dayTrades of days) {
    dayIndex++;
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * NQ_POINT_VALUE_USD;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", clearedEval, daysToClearEval, payoutCount, totalProtected };
    }
    if (!locked) {
      if (balance > phaseAnchor + LUCID_DD + 100) {
        locked = true;
        floor = phaseAnchor + 100;
      } else {
        floor = Math.max(floor, balance - LUCID_DD);
      }
    }

    if (inEval) {
      evalDays++;
      evalDailyPnL.push(dayPnl);
      const totalProfit = balance - ACCOUNT_SIZE;
      const bestDay = Math.max(...evalDailyPnL);
      const consistencyOk = totalProfit <= 0 || bestDay <= LUCID_CONSISTENCY_PCT * totalProfit;
      if (totalProfit >= COMBINE_TARGET && evalDays >= 1 && consistencyOk) {
        inEval = false;
        clearedEval = true;
        daysToClearEval = dayIndex;
        cycleStart = balance;
        phaseAnchor = balance;
        floor = balance - LUCID_DD;
        locked = false;
      }
      continue;
    }

    if (dayPnl >= LUCID_WIN_DAY_THRESHOLD) winningDaysThisCycle++;
    const cycleProfit = balance - cycleStart;
    if (winningDaysThisCycle >= LUCID_WINNING_DAYS_NEEDED && cycleProfit > 0) {
      const raw = Math.min(LUCID_PAYOUT_CAP, 0.5 * balance);
      const payoutAmount = Math.min(raw, cycleProfit);
      if (payoutAmount >= LUCID_MIN_PAYOUT) {
        balance -= payoutAmount;
        totalProtected += payoutAmount;
        payoutCount++;
        if (payoutCount >= LUCID_MAX_PAYOUTS) return { status: "graduated_or_capped", clearedEval, daysToClearEval, payoutCount, totalProtected };
        cycleStart = balance;
        winningDaysThisCycle = 0;
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - LUCID_DD;
        }
      }
    }
  }
  return { status: "ran_out_of_data", clearedEval, daysToClearEval, payoutCount, totalProtected };
}

// -- MyFundedFutures Pro 150K: 16:10 deadline, $4,600 DD, no consistency, ~10-trading-day
// cycles, 80% split, no per-request cap.
const mffTrades = buildVolumeSpikeFilteredTrades(nq5m, 16, 10);
const mffDayBuckets = buildDayBuckets(nq5m, mffTrades);
const MFF_PRO_DD = 4_600;
const MFF_PRO_MIN_EVAL_DAYS = 2;
const MFF_PRO_CYCLE_TRADING_DAYS = 10;
const MFF_PRO_SPLIT = 0.8;

function runMffProTrial(days: Trade[][]): FullResult {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let inEval = true;
  let evalDays = 0;
  let clearedEval = false;
  let daysToClearEval: number | null = null;
  let cycleStart = ACCOUNT_SIZE;
  let cycleDays = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let dayIndex = 0;

  for (const dayTrades of days) {
    dayIndex++;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * NQ_POINT_VALUE_USD;
      balance += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= MFF_PRO_DD) return { status: "busted", clearedEval, daysToClearEval, payoutCount, totalProtected };
    }
    if (inEval) {
      evalDays++;
      const totalProfit = balance - ACCOUNT_SIZE;
      if (totalProfit >= COMBINE_TARGET && evalDays >= MFF_PRO_MIN_EVAL_DAYS) {
        inEval = false;
        clearedEval = true;
        daysToClearEval = dayIndex;
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
  return { status: "ran_out_of_data", clearedEval, daysToClearEval, payoutCount, totalProtected };
}

// -- Apex 150K: 16:59 deadline, $5,000 DD (locks at safety net), no eval consistency,
// funded 6-step ladder, 5 qualifying days >= $350 (150K tier), $500 min, 50% consistency.
const apexTrades = buildVolumeSpikeFilteredTrades(nq5m, 16, 59);
const apexDayBuckets = buildDayBuckets(nq5m, apexTrades);
const APEX_DD = 5_000;
const APEX_LADDER_CAPS = [2_500, 3_000, 3_000, 3_000, 4_000, 5_000];
const APEX_MIN_DAYS = 5;
const APEX_QUALIFYING_DAY_MIN_PROFIT = 350;
const APEX_MIN_REQUEST = 500;
const APEX_CONSISTENCY_PCT = 0.5;

function runApexTrial(days: Trade[][]): FullResult {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - APEX_DD;
  let locked = false;
  let inEval = true;
  let evalDays = 0;
  let clearedEval = false;
  let daysToClearEval: number | null = null;
  let cycleStart = ACCOUNT_SIZE;
  let cycleDailyPnL: number[] = [];
  let payoutCount = 0;
  let totalProtected = 0;
  let dayIndex = 0;

  for (const dayTrades of days) {
    dayIndex++;
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * NQ_POINT_VALUE_USD;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      if (balance < floor) return { status: "busted", clearedEval, daysToClearEval, payoutCount, totalProtected };
      if (!locked) {
        if (peak >= ACCOUNT_SIZE + APEX_DD + 100) {
          locked = true;
          floor = ACCOUNT_SIZE + 100;
        } else {
          floor = Math.max(floor, peak - APEX_DD);
        }
      }
    }
    if (inEval) {
      evalDays++;
      const totalProfit = balance - ACCOUNT_SIZE;
      if (totalProfit >= COMBINE_TARGET && evalDays >= 1) {
        inEval = false;
        clearedEval = true;
        daysToClearEval = dayIndex;
        cycleStart = balance;
      }
      continue;
    }
    cycleDailyPnL.push(dayPnl);
    const cycleProfit = balance - cycleStart;
    const qualifyingDays = cycleDailyPnL.filter((p) => p >= APEX_QUALIFYING_DAY_MIN_PROFIT).length;
    const daysOk = qualifyingDays >= APEX_MIN_DAYS;
    const bestDay = Math.max(...cycleDailyPnL);
    const consistencyOk = cycleProfit <= 0 || bestDay <= APEX_CONSISTENCY_PCT * cycleProfit;
    if (daysOk && cycleProfit >= APEX_MIN_REQUEST && consistencyOk) {
      const cap = APEX_LADDER_CAPS[Math.min(payoutCount, APEX_LADDER_CAPS.length - 1)]!;
      const payoutAmount = Math.min(cap, cycleProfit);
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStart = balance;
      cycleDailyPnL = [];
    }
  }
  return { status: "ran_out_of_data", clearedEval, daysToClearEval, payoutCount, totalProtected };
}

function report(label: string, results: FullResult[], oldNote: string) {
  const busted = results.filter((r) => r.status === "busted");
  const cleared = results.filter((r) => r.clearedEval);
  const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
  const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
  const pAtLeastOne = (results.filter((r) => r.payoutCount >= 1).length / results.length) * 100;
  console.log("-".repeat(100));
  console.log(label);
  console.log("-".repeat(100));
  console.log(`Cleared eval: ${((cleared.length / results.length) * 100).toFixed(1)}%   Busted: ${((busted.length / results.length) * 100).toFixed(1)}%`);
  console.log(`Avg payouts: ${avgPayouts.toFixed(2)}   P(at least 1 payout): ${pAtLeastOne.toFixed(1)}%   Expected total protected: $${avgProtected.toFixed(0)}\n`);
  console.log(`FOR COMPARISON:\n  ${oldNote}\n`);
  return { clearRate: (cleared.length / results.length) * 100, bustRate: (busted.length / results.length) * 100, avgPayouts, pAtLeastOne, avgProtected };
}

function main() {
  console.log("=".repeat(100));
  console.log("Prop-firm eval + payout rebuild with the VOLUME-SPIKE-FILTERED baseline (1.5x/20-bar)");
  console.log("=".repeat(100));
  console.log(`LucidFlex trades (16:45 deadline): ${lucidTrades.length} across ${lucidDayBuckets.length} days`);
  console.log(`MyFundedFutures trades (16:10 deadline): ${mffTrades.length} across ${mffDayBuckets.length} days`);
  console.log(`Apex trades (16:59 deadline): ${apexTrades.length} across ${apexDayBuckets.length} days\n`);

  const lucidShuffled: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) lucidShuffled.push(shuffle(lucidDayBuckets));
  const lucidResults = lucidShuffled.map(runLucidTrial);
  const lucidSummary = report(
    "LucidFlex 150K (volume-spike filtered)",
    lucidResults,
    "unfiltered: expected $2,484   |   VA-only: expected $2,063   |   stacked (VA+dailyOpen): expected $302",
  );

  const mffShuffled: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) mffShuffled.push(shuffle(mffDayBuckets));
  const mffResults = mffShuffled.map(runMffProTrial);
  const mffSummary = report(
    "MyFundedFutures Pro 150K (volume-spike filtered)",
    mffResults,
    "unfiltered: expected $3,617   |   VA-only: expected $1,295   |   stacked (VA+dailyOpen): expected $52",
  );

  const apexShuffled: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) apexShuffled.push(shuffle(apexDayBuckets));
  const apexResults = apexShuffled.map(runApexTrial);
  const apexSummary = report(
    "Apex 150K (volume-spike filtered)",
    apexResults,
    "unfiltered: expected $2,837   |   VA-only: expected $2,158   |   stacked (VA+dailyOpen): expected $378",
  );

  writeFileSync(
    "data/prop-firms-volume-spike-rebuild-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, lucidFlex150K: lucidSummary, mffPro150K: mffSummary, apex150K: apexSummary }, null, 2),
  );
  console.log("Full results written to data/prop-firms-volume-spike-rebuild-results.json");
}

main();
