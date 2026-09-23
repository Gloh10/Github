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

// -- Build the flagship trade set with Apex 4.0's real deadline (4:59pm ET).
const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const baseSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const trades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 59 });
const avgRiskPoints = trades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / trades.length;

const dayBucketsMap = new Map<string, Trade[]>();
for (const t of trades) {
  const key = nyDateKey(nq5m[t.barIndex]!.t);
  if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
  dayBucketsMap.get(key)!.push(t);
}
const dayBuckets = [...dayBucketsMap.values()];

// -- Apex 25K, verified via search: profit target $1,500, trailing DD $1,500 (locks at
// safety net), no eval consistency, max 4 NQ contracts. Funded: 5 qualifying days needing
// >= $100 net each, 50% consistency, FLAT $1,000 payout cap (no ladder on this tier), max
// 6 payouts = $6,000 lifetime cap on this single account.
const ACCOUNT_SIZE = 25_000;
const COMBINE_TARGET = 1_500;
const DD_AMOUNT = 1_500;
const MAX_CONTRACTS_NQ = 4;
const QUALIFYING_DAY_MIN_PROFIT = 100;
const QUALIFYING_DAYS_NEEDED = 5;
const CONSISTENCY_PCT = 0.5;
const PAYOUT_CAP = 1_000;
const MAX_PAYOUTS = 6;

// Sizing: same method used throughout this session -- target ~1/6 of the DD budget at risk
// per trade, switch to MNQ micros if a single NQ contract would eat too much of that budget.
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
  let peak = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let inEval = true;
  let evalDays = 0;
  let clearedEval = false;
  let cycleStart = ACCOUNT_SIZE;
  let cycleDailyPnL: number[] = [];
  let payoutCount = 0;
  let totalProtected = 0;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      if (balance < floor) return { status: "busted", clearedEval, payoutCount, totalProtected };
      if (!locked) {
        if (peak >= ACCOUNT_SIZE + DD_AMOUNT + 100) {
          locked = true;
          floor = ACCOUNT_SIZE + 100;
        } else {
          floor = Math.max(floor, peak - DD_AMOUNT);
        }
      }
    }

    if (inEval) {
      evalDays++;
      const totalProfit = balance - ACCOUNT_SIZE;
      if (totalProfit >= COMBINE_TARGET && evalDays >= 1) {
        inEval = false;
        clearedEval = true;
        cycleStart = balance;
      }
      continue;
    }

    cycleDailyPnL.push(dayPnl);
    const cycleProfit = balance - cycleStart;
    const qualifyingDays = cycleDailyPnL.filter((p) => p >= QUALIFYING_DAY_MIN_PROFIT).length;
    const bestDay = Math.max(...cycleDailyPnL);
    const consistencyOk = cycleProfit <= 0 || bestDay <= CONSISTENCY_PCT * cycleProfit;
    if (qualifyingDays >= QUALIFYING_DAYS_NEEDED && cycleProfit > 0 && consistencyOk) {
      const payoutAmount = Math.min(PAYOUT_CAP, cycleProfit);
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      if (payoutCount >= MAX_PAYOUTS) return { status: "hit_payout_cap", clearedEval, payoutCount, totalProtected };
      cycleStart = balance;
      cycleDailyPnL = [];
    }
  }
  return { status: "ran_out_of_data", clearedEval, payoutCount, totalProtected };
}

function main() {
  console.log("=".repeat(100));
  console.log("Apex 25K -- realistic (4:59pm ET forced-exit) bootstrap plan for limited starting capital");
  console.log("=".repeat(100));
  console.log(`Underlying: ${trades.length} trades across ${dayBuckets.length} distinct NY trading days`);
  console.log(`Sizing: ${contracts} ${useMicro ? "MNQ micro" : "NQ full-size"} contract(s), ${(ddPctPerTrade * 100).toFixed(1)}% of the $${DD_AMOUNT.toLocaleString()} DD budget per trade\n`);

  const results: TrialResult[] = [];
  for (let i = 0; i < TRIALS; i++) results.push(runOneTrial(shuffle(dayBuckets)));

  const cleared = results.filter((r) => r.clearedEval);
  const busted = results.filter((r) => r.status === "busted");
  const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
  const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
  const pAtLeastOne = (results.filter((r) => r.payoutCount >= 1).length / TRIALS) * 100;

  console.log(`Cleared the eval: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   Busted (eval or funded): ${((busted.length / TRIALS) * 100).toFixed(1)}%`);
  console.log(`Avg payouts landed: ${avgPayouts.toFixed(2)}   P(at least 1 payout): ${pAtLeastOne.toFixed(1)}%`);
  console.log(`Expected total extraction (all trials): $${avgProtected.toFixed(0)}\n`);

  // Real cost, verified via search: $11.80 eval (90%-off SAVENOW promo) + $79 PA activation.
  const evalCostPromo = 11.8;
  const activationCost = 79;
  const totalCostPromo = evalCostPromo + activationCost;
  const evalCostList = 118;
  const totalCostList = evalCostList + activationCost;

  console.log("-".repeat(100));
  console.log("NET ECONOMICS -- one account, your own capital at risk");
  console.log("-".repeat(100));
  console.log(`All-in cost with the 90% promo (SAVENOW): $${evalCostPromo.toFixed(2)} eval + $${activationCost} PA activation = $${totalCostPromo.toFixed(2)}`);
  console.log(`  Net expected: $${(avgProtected - totalCostPromo).toFixed(0)}`);
  console.log(`All-in cost at list price (no promo): $${evalCostList} eval + $${activationCost} PA activation = $${totalCostList}`);
  console.log(`  Net expected: $${(avgProtected - totalCostList).toFixed(0)}`);
  console.log(`\nLifetime cap on THIS single account: 6 payouts x $1,000 = $6,000 (would take many more trading days than the current ${dayBuckets.length}-day data pool to reach).`);

  writeFileSync(
    "data/apex-25k-realistic-bootstrap-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        trials: TRIALS,
        distinctDays: dayBuckets.length,
        sizing: { instrument: useMicro ? "MNQ" : "NQ", contracts, ddPctPerTrade: ddPctPerTrade * 100 },
        clearRate: (cleared.length / TRIALS) * 100,
        bustRate: (busted.length / TRIALS) * 100,
        avgPayouts,
        pAtLeastOne,
        avgProtected,
        netExpectedPromo: avgProtected - totalCostPromo,
        netExpectedList: avgProtected - totalCostList,
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/apex-25k-realistic-bootstrap-results.json");
}

main();
