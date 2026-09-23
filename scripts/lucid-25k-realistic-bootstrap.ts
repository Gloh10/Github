import { readFileSync, writeFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
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

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const baseSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const trades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 45 });
const avgRiskPoints = trades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / trades.length;

const dayBucketsMap = new Map<string, Trade[]>();
for (const t of trades) {
  const key = nyDateKey(nq5m[t.barIndex]!.t);
  if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
  dayBucketsMap.get(key)!.push(t);
}
const dayBuckets = [...dayBucketsMap.values()];

// LucidFlex 25K. Combine target/DD verified via earlier general search (not the user's own
// screenshots, which only covered 150K) -- lower confidence than the Apex 25K figures.
// Winning-day $ threshold for 25K is NOT independently verified; scaled down proportionally
// from the confirmed 150K figure ($250 per $4,500 DD) as a disclosed assumption: ~$56/day.
const ACCOUNT_SIZE = 25_000;
const COMBINE_TARGET = 1_250;
const DD_AMOUNT = 1_000;
const EVAL_CONSISTENCY_PCT = 0.5;
const PAYOUT_CAP = 1_000;
const WINNING_DAY_THRESHOLD = Math.round(250 * (DD_AMOUNT / 4_500)); // ASSUMPTION -- scaled from the verified 150K figure
const WINNING_DAYS_NEEDED = 5;
const MIN_PAYOUT = 500;
const MAX_PAYOUTS = 5;
const MAX_CONTRACTS_NQ = 4;

const oneNqContractRiskPct = (avgRiskPoints * NQ_POINT_VALUE_USD) / DD_AMOUNT;
const useMicro = oneNqContractRiskPct > 0.2;
const pointValue = useMicro ? MNQ_POINT_VALUE_USD : NQ_POINT_VALUE_USD;
const targetRiskDollars = DD_AMOUNT / 6;
const maxContracts = useMicro ? MAX_CONTRACTS_NQ * 10 : MAX_CONTRACTS_NQ;
const contracts = Math.max(1, Math.min(maxContracts, Math.floor(targetRiskDollars / (avgRiskPoints * pointValue))));
const ddPctPerTrade = (avgRiskPoints * pointValue * contracts) / DD_AMOUNT;

interface TrialResult {
  status: "busted" | "ran_out_of_data" | "hit_payout_cap";
  clearedEval: boolean;
  payoutCount: number;
  totalProtected: number;
}

function runOneTrial(shuffled: Trade[][]): TrialResult {
  let balance = ACCOUNT_SIZE;
  let phaseAnchor = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let inEval = true;
  let evalDays = 0;
  const evalDailyPnL: number[] = [];
  let clearedEval = false;
  let cycleStart = ACCOUNT_SIZE;
  let winningDaysThisCycle = 0;
  let payoutCount = 0;
  let totalProtected = 0;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", clearedEval, payoutCount, totalProtected };
    }
    if (!locked) {
      if (balance > phaseAnchor + DD_AMOUNT + 100) {
        locked = true;
        floor = phaseAnchor + 100;
      } else {
        floor = Math.max(floor, balance - DD_AMOUNT);
      }
    }

    if (inEval) {
      evalDays++;
      evalDailyPnL.push(dayPnl);
      const totalProfit = balance - ACCOUNT_SIZE;
      const bestDay = Math.max(...evalDailyPnL);
      const consistencyOk = totalProfit <= 0 || bestDay <= EVAL_CONSISTENCY_PCT * totalProfit;
      if (totalProfit >= COMBINE_TARGET && evalDays >= 1 && consistencyOk) {
        inEval = false;
        clearedEval = true;
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
        if (payoutCount >= MAX_PAYOUTS) return { status: "hit_payout_cap", clearedEval, payoutCount, totalProtected };
        cycleStart = balance;
        winningDaysThisCycle = 0;
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - DD_AMOUNT;
        }
      }
    }
  }
  return { status: "ran_out_of_data", clearedEval, payoutCount, totalProtected };
}

function main() {
  console.log("=".repeat(100));
  console.log("LucidFlex 25K -- realistic (4:45pm ET forced-exit) bootstrap option, for comparison against Apex 25K");
  console.log("=".repeat(100));
  console.log(`Underlying: ${trades.length} trades across ${dayBuckets.length} distinct NY trading days`);
  console.log(`Sizing: ${contracts} ${useMicro ? "MNQ micro" : "NQ full-size"} contract(s), ${(ddPctPerTrade * 100).toFixed(1)}% of the $${DD_AMOUNT.toLocaleString()} DD budget per trade`);
  console.log(`Winning-day threshold used: $${WINNING_DAY_THRESHOLD} (ASSUMPTION, scaled from the verified 150K figure -- not independently confirmed for 25K)\n`);

  const results: TrialResult[] = [];
  for (let i = 0; i < TRIALS; i++) results.push(runOneTrial(shuffle(dayBuckets)));

  const cleared = results.filter((r) => r.clearedEval);
  const busted = results.filter((r) => r.status === "busted");
  const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
  const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
  const pAtLeastOne = (results.filter((r) => r.payoutCount >= 1).length / TRIALS) * 100;

  console.log(`Cleared the eval: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   Busted: ${((busted.length / TRIALS) * 100).toFixed(1)}%`);
  console.log(`Avg payouts landed: ${avgPayouts.toFixed(2)}   P(at least 1 payout): ${pAtLeastOne.toFixed(1)}%`);
  console.log(`Expected total extraction (all trials): $${avgProtected.toFixed(0)}\n`);

  const evalCostPromo = 53.4; // verified: VIBES 30%-off code
  const evalCostList = 89;
  console.log("-".repeat(100));
  console.log("NET ECONOMICS -- one account, your own capital at risk");
  console.log("-".repeat(100));
  console.log(`Promo pricing ($${evalCostPromo}, no separate activation fee): net expected $${(avgProtected - evalCostPromo).toFixed(0)}`);
  console.log(`List pricing ($${evalCostList}): net expected $${(avgProtected - evalCostList).toFixed(0)}`);

  writeFileSync(
    "data/lucid-25k-realistic-bootstrap-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        trials: TRIALS,
        distinctDays: dayBuckets.length,
        winningDayThresholdAssumed: WINNING_DAY_THRESHOLD,
        sizing: { instrument: useMicro ? "MNQ" : "NQ", contracts, ddPctPerTrade: ddPctPerTrade * 100 },
        clearRate: (cleared.length / TRIALS) * 100,
        bustRate: (busted.length / TRIALS) * 100,
        avgPayouts,
        pAtLeastOne,
        avgProtected,
        netExpectedPromo: avgProtected - evalCostPromo,
        netExpectedList: avgProtected - evalCostList,
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/lucid-25k-realistic-bootstrap-results.json");
}

main();
