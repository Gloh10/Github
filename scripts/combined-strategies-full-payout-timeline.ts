import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy, simulateTradesWithPointsTrail } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { rejectionBlock, vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const MNQ_POINT_VALUE_USD = 2;
const TRIALS = 2000;

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

interface SizedTrade {
  trade: Trade;
  contracts: number;
  pointValue: number;
}

// -- Flagship: 5-min NQ, 1 full NQ contract.
const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const flagshipSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const flagshipTrades = runStrategy("flagship", nq5m, flagshipSignals).trades;
const flagshipDayMap = new Map<string, Trade[]>();
for (const t of flagshipTrades) {
  const key = nyDateKey(nq5m[t.barIndex]!.t);
  if (!flagshipDayMap.has(key)) flagshipDayMap.set(key, []);
  flagshipDayMap.get(key)!.push(t);
}
const flagshipDayBuckets = [...flagshipDayMap.values()].map((dayTrades) => dayTrades.map((t): SizedTrade => ({ trade: t, contracts: 1, pointValue: NQ_POINT_VALUE_USD })));

// -- Rejection block: 1h NQ, 4 MNQ contracts.
const nq1h = loadBars("data/nq-1h.json");
const rbSignals = rejectionBlock(nq1h, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
const rbTrades = simulateTradesWithPointsTrail(nq1h, rbSignals, { breakevenTriggerPoints: 0, trailStartPoints: 5, trailDistancePoints: 2 });
const rbDayMap = new Map<string, Trade[]>();
for (const t of rbTrades) {
  const key = nyDateKey(nq1h[t.barIndex]!.t);
  if (!rbDayMap.has(key)) rbDayMap.set(key, []);
  rbDayMap.get(key)!.push(t);
}
const rbDayBuckets = [...rbDayMap.values()].map((dayTrades) => dayTrades.map((t): SizedTrade => ({ trade: t, contracts: 4, pointValue: MNQ_POINT_VALUE_USD })));

function buildCombinedDays(): SizedTrade[][] {
  const flagshipShuffled = shuffle(flagshipDayBuckets);
  const rbShuffled = shuffle(rbDayBuckets).slice(0, flagshipShuffled.length);
  return flagshipShuffled.map((fDay, i) => [...fDay, ...(rbShuffled[i] ?? [])]);
}

const ACCOUNT_SIZE = 150_000;

interface FullResult {
  status: "busted" | "ran_out_of_data" | "graduated_or_capped";
  clearedEval: boolean;
  daysToClearEval: number | null;
  payoutCount: number;
  totalProtected: number;
  daysToFirstPayout: number | null;
}

// ---------------------------------------------------------------------------
// LucidFlex 150K: eval ($9,000 target, $4,500 MLL, 50% consistency, lock-at-
// safety-net EOD trailing) then funded stage (5 days >= $250, $3,000 payout
// cap, 5 payouts max before graduating).
// ---------------------------------------------------------------------------
const LUCID_DD = 4_500;
const LUCID_TARGET = 9_000;
const LUCID_CONSISTENCY_PCT = 0.5;
const LUCID_PAYOUT_CAP = 3_000;
const LUCID_WIN_DAY_THRESHOLD = 250;
const LUCID_WINNING_DAYS_NEEDED = 5;
const LUCID_MIN_PAYOUT = 500;
const LUCID_MAX_PAYOUTS = 5;

function runLucidFullTrial(days: SizedTrade[][]): FullResult {
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
  let daysToFirstPayout: number | null = null;
  let dayIndex = 0;

  for (const dayTrades of days) {
    dayIndex++;
    let dayPnl = 0;
    for (const st of dayTrades) {
      const riskPoints = Math.abs(st.trade.entry - st.trade.stop);
      const pnl = st.trade.rMultiple * riskPoints * st.pointValue * st.contracts;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", clearedEval, daysToClearEval, payoutCount, totalProtected, daysToFirstPayout };
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
      if (totalProfit >= LUCID_TARGET && evalDays >= 1 && consistencyOk) {
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
        if (daysToFirstPayout === null) daysToFirstPayout = dayIndex;
        if (payoutCount >= LUCID_MAX_PAYOUTS) return { status: "graduated_or_capped", clearedEval, daysToClearEval, payoutCount, totalProtected, daysToFirstPayout };
        cycleStart = balance;
        winningDaysThisCycle = 0;
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - LUCID_DD;
        }
      }
    }
  }
  return { status: "ran_out_of_data", clearedEval, daysToClearEval, payoutCount, totalProtected, daysToFirstPayout };
}

// ---------------------------------------------------------------------------
// MyFundedFutures Pro 150K: eval ($9,000 target, $4,600 DD, NO consistency,
// EOD trailing, no lock mechanic) then funded stage (~10 trading days/cycle
// approximating the real 14-calendar-day window, 80% split, no per-request
// cap).
// ---------------------------------------------------------------------------
const MFF_PRO_DD = 4_600;
const MFF_PRO_TARGET = 9_000;
const MFF_PRO_MIN_EVAL_DAYS = 2;
const MFF_PRO_CYCLE_TRADING_DAYS = 10;
const MFF_PRO_SPLIT = 0.8;

function runMffProFullTrial(days: SizedTrade[][]): FullResult {
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
  let daysToFirstPayout: number | null = null;
  let dayIndex = 0;

  for (const dayTrades of days) {
    dayIndex++;
    for (const st of dayTrades) {
      const riskPoints = Math.abs(st.trade.entry - st.trade.stop);
      const pnl = st.trade.rMultiple * riskPoints * st.pointValue * st.contracts;
      balance += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= MFF_PRO_DD) return { status: "busted", clearedEval, daysToClearEval, payoutCount, totalProtected, daysToFirstPayout };
    }

    if (inEval) {
      evalDays++;
      const totalProfit = balance - ACCOUNT_SIZE;
      if (totalProfit >= MFF_PRO_TARGET && evalDays >= MFF_PRO_MIN_EVAL_DAYS) {
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
      if (daysToFirstPayout === null) daysToFirstPayout = dayIndex;
      cycleStart = balance;
      cycleDays = 0;
      peak = balance;
    }
  }
  return { status: "ran_out_of_data", clearedEval, daysToClearEval, payoutCount, totalProtected, daysToFirstPayout };
}

function report(label: string, results: FullResult[]) {
  const busted = results.filter((r) => r.status === "busted");
  const graduated = results.filter((r) => r.status === "graduated_or_capped");
  const clearedEval = results.filter((r) => r.clearedEval);
  const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
  const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
  const withDaysToClear = clearedEval.filter((r) => r.daysToClearEval !== null);
  const avgDaysToClearEval = withDaysToClear.length > 0 ? withDaysToClear.reduce((s, r) => s + r.daysToClearEval!, 0) / withDaysToClear.length : NaN;
  const withFirstPayout = results.filter((r) => r.daysToFirstPayout !== null);
  const avgDaysToFirstPayout = withFirstPayout.length > 0 ? withFirstPayout.reduce((s, r) => s + r.daysToFirstPayout!, 0) / withFirstPayout.length : NaN;
  const pAtLeastOnePayout = (results.filter((r) => r.payoutCount >= 1).length / results.length) * 100;

  console.log("-".repeat(100));
  console.log(label);
  console.log("-".repeat(100));
  console.log(`Cleared the eval: ${((clearedEval.length / results.length) * 100).toFixed(1)}%   avg days to clear: ${avgDaysToClearEval.toFixed(1)}`);
  console.log(`Busted (anywhere in eval or funded): ${((busted.length / results.length) * 100).toFixed(1)}%   Hit payout cap/graduated: ${((graduated.length / results.length) * 100).toFixed(1)}%`);
  console.log(`Avg payouts landed: ${avgPayouts.toFixed(2)}   P(at least 1 payout): ${pAtLeastOnePayout.toFixed(1)}%   avg days to 1st payout: ${avgDaysToFirstPayout.toFixed(1)}`);
  console.log(`Expected total protected (all trials): $${avgProtected.toFixed(0)}\n`);

  return {
    clearRate: (clearedEval.length / results.length) * 100,
    avgDaysToClearEval,
    bustRate: (busted.length / results.length) * 100,
    graduatedRate: (graduated.length / results.length) * 100,
    avgPayouts,
    pAtLeastOnePayout,
    avgDaysToFirstPayout,
    avgProtected,
  };
}

function main() {
  console.log("=".repeat(100));
  console.log("Flagship + Rejection Block COMBINED -- full eval-to-payout timeline, both firms");
  console.log("=".repeat(100));
  console.log(`Flagship: ${flagshipTrades.length} trades / ${flagshipDayBuckets.length} days (5-min NQ, 1 NQ contract)`);
  console.log(`Rejection block: ${rbTrades.length} trades / ${rbDayBuckets.length} days (1h NQ, 4 MNQ contracts)`);
  console.log(`Combined-day pairing: 1 random flagship day + 1 random rejection-block day = 1 combined day, capped at ${flagshipDayBuckets.length} combined days/trial`);
  console.log(`(the smaller pool -- this models running both strategies going forward over the same near-term calendar window, not literal date overlap)\n`);

  const lucidResults: FullResult[] = [];
  const mffProResults: FullResult[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const days = buildCombinedDays();
    lucidResults.push(runLucidFullTrial(days));
    mffProResults.push(runMffProFullTrial(days)); // SAME combined day sequence -- paired comparison
  }

  const lucidSummary = report("LucidFlex 150K -- combined strategy, full eval + funded timeline", lucidResults);
  const mffProSummary = report("MyFundedFutures Pro 150K -- combined strategy, full eval + funded timeline", mffProResults);

  console.log("=".repeat(100));
  console.log("FOR COMPARISON -- single-strategy numbers established earlier this session:");
  console.log("=".repeat(100));
  console.log("  Flagship ONLY, LucidFlex eval: 6.9 avg days to clear, 99.9% clear rate");
  console.log("  Flagship ONLY, LucidFlex funded stage (post-eval): ~1.0 avg payouts within its 18-day pool, ~$2,979 expected");
  console.log("  Rejection block ONLY, MFF Pro funded stage (post-eval): 3.00 avg payouts, $7,036 expected (within its own 32-day pool)");

  writeFileSync(
    "data/combined-strategies-full-payout-timeline-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, lucidFlex150K: lucidSummary, mffPro150K: mffProSummary }, null, 2),
  );
  console.log("\nFull results written to data/combined-strategies-full-payout-timeline-results.json");
}

main();
