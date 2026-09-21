import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 5000; // more trials than usual -- we need the tail of the payout-count distribution, not just the mean

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

// LucidFlex 150K, figures taken directly from the user's own account screenshots.
const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500; // Max Loss Limit, EOD trailing, locks permanently at accountSize+$100 once crossed
const EVAL_CONSISTENCY_PCT = 0.5;
const WINNING_DAY_THRESHOLD = 250; // "Min Days of Profit: 5 of $250"
const WINNING_DAYS_NEEDED = 5;
const PAYOUT_CAP = 3_000; // 150K tier: 50% of balance up to $3,000/request
const MIN_PAYOUT = 500;
const MAX_PAYOUTS_ON_FLEX = 5; // "Payouts to Live: 5" -- 6th+ payout means you've graduated off Flex entirely
const CONTRACTS = 1; // sized earlier at 9.5% of DD budget -- 1 full NQ contract

interface DepthResult {
  status: "busted" | "ran_out_of_data" | "graduated";
  payoutCount: number;
  totalProtected: number;
  payoutAmounts: number[];
  daysUsedTotal: number;
}

function runOneTrial(shuffled: Trade[][]): DepthResult {
  let balance = ACCOUNT_SIZE;
  let inCombine = true;
  let phaseAnchor = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let combineDays = 0;
  const combineDailyPnL: number[] = [];
  let cycleStartBalance = ACCOUNT_SIZE;
  let winningDaysThisCycle = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  const payoutAmounts: number[] = [];
  let daysUsed = 0;

  for (const dayTrades of shuffled) {
    daysUsed++;
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * NQ_POINT_VALUE_USD * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", payoutCount, totalProtected, payoutAmounts, daysUsedTotal: daysUsed };
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
        cycleStartBalance = balance;
        phaseAnchor = balance;
        floor = balance - DD_AMOUNT;
        locked = false;
      }
      continue;
    }

    if (dayPnl >= WINNING_DAY_THRESHOLD) winningDaysThisCycle++;
    const cycleProfit = balance - cycleStartBalance;
    if (winningDaysThisCycle >= WINNING_DAYS_NEEDED && cycleProfit > 0) {
      const raw = Math.min(PAYOUT_CAP, 0.5 * balance);
      const payoutAmount = Math.min(raw, cycleProfit);
      if (payoutAmount >= MIN_PAYOUT) {
        balance -= payoutAmount;
        totalProtected += payoutAmount;
        payoutAmounts.push(payoutAmount);
        payoutCount++;
        if (payoutCount >= MAX_PAYOUTS_ON_FLEX) {
          return { status: "graduated", payoutCount, totalProtected, payoutAmounts, daysUsedTotal: daysUsed };
        }
        cycleStartBalance = balance;
        winningDaysThisCycle = 0;
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - DD_AMOUNT;
        }
      }
    }
  }
  return { status: "ran_out_of_data", payoutCount, totalProtected, payoutAmounts, daysUsedTotal: daysUsed };
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

  console.log(`LucidFlex 150K -- how far can front-loaded withdrawals go before running out of headroom?`);
  console.log(`Rules used (from the user's own account screenshots): profit target $9,000, Max Loss Limit $4,500 (EOD trailing,`);
  console.log(`locks permanently once crossed), 50% eval consistency, funded stage needs 5 days >= $250 net per cycle, payout`);
  console.log(`cap $3,000/request (50% of balance, min $500), and Lucid caps Flex itself at 5 payouts before you graduate to LucidLive.`);
  console.log(`CRITICAL CAVEAT: the underlying strategy only has ${dayBuckets.length} distinct historical trading days of data (the max`);
  console.log(`obtainable from TradingView's 5-min bar cap). Each trial draws from that SAME fixed pool without replacement, so running`);
  console.log(`out of data (not busting, not hitting Lucid's 5-payout cap) is very likely to be the actual ceiling here -- this measures`);
  console.log(`"how many payout cycles fit inside 18 days of history," not a true long-run steady-state rate.\n`);

  const results: DepthResult[] = [];
  for (let i = 0; i < TRIALS; i++) results.push(runOneTrial(shuffle(dayBuckets)));

  const byStatus = {
    busted: results.filter((r) => r.status === "busted").length,
    ranOutOfData: results.filter((r) => r.status === "ran_out_of_data").length,
    graduated: results.filter((r) => r.status === "graduated").length,
  };

  console.log("=".repeat(90));
  console.log("OUTCOME BREAKDOWN");
  console.log("=".repeat(90));
  console.log(`Busted (hit the DD floor):                          ${((byStatus.busted / TRIALS) * 100).toFixed(1)}%`);
  console.log(`Ran out of historical data before next cycle:       ${((byStatus.ranOutOfData / TRIALS) * 100).toFixed(1)}%`);
  console.log(`Reached Lucid's 5-payout Flex cap (graduated):      ${((byStatus.graduated / TRIALS) * 100).toFixed(1)}%\n`);

  console.log("=".repeat(90));
  console.log("PAYOUT-COUNT DISTRIBUTION (how many payouts actually landed, across all trials)");
  console.log("=".repeat(90));
  for (let n = 0; n <= MAX_PAYOUTS_ON_FLEX; n++) {
    const atN = results.filter((r) => r.payoutCount === n);
    const pct = (atN.length / TRIALS) * 100;
    const avgProtectedAtN = atN.length > 0 ? atN.reduce((s, r) => s + r.totalProtected, 0) / atN.length : 0;
    console.log(`  ${n} payout(s): ${pct.toFixed(1).padStart(5)}% of trials   avg $ protected when landing here: $${avgProtectedAtN.toFixed(0)}`);
  }

  console.log("\n" + "=".repeat(90));
  console.log("EXPECTED VALUE SUMMARY");
  console.log("=".repeat(90));
  const avgTotalProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
  const avgPayoutCount = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
  const reachedAtLeastOne = results.filter((r) => r.payoutCount >= 1);
  const avgFirstPayout = reachedAtLeastOne.length > 0 ? reachedAtLeastOne.reduce((s, r) => s + r.payoutAmounts[0]!, 0) / reachedAtLeastOne.length : NaN;
  const reachedAtLeastTwo = results.filter((r) => r.payoutCount >= 2);
  const avgSecondPayout = reachedAtLeastTwo.length > 0 ? reachedAtLeastTwo.reduce((s, r) => s + r.payoutAmounts[1]!, 0) / reachedAtLeastTwo.length : NaN;

  console.log(`Expected total protected (all trials, all payout counts blended): $${avgTotalProtected.toFixed(0)}`);
  console.log(`Expected number of payouts landed: ${avgPayoutCount.toFixed(2)}`);
  console.log(`P(at least 1 payout): ${((reachedAtLeastOne.length / TRIALS) * 100).toFixed(1)}%   avg size of that 1st payout: $${avgFirstPayout.toFixed(0)}`);
  console.log(`P(at least 2 payouts): ${((reachedAtLeastTwo.length / TRIALS) * 100).toFixed(1)}%   avg size of that 2nd payout: $${avgSecondPayout.toFixed(0)}`);
  console.log(`\n(This is exactly the "1-2 payouts, then move to MyFunded" window you described -- see how much of the`);
  console.log(`probability mass sits at 0/1/2 payouts above before assuming you'll comfortably reach 2.)`);

  writeFileSync(
    "data/lucidflex-150k-payout-depth-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        trials: TRIALS,
        distinctHistoricalDays: dayBuckets.length,
        byStatus,
        avgTotalProtected,
        avgPayoutCount,
        pAtLeast1: (reachedAtLeastOne.length / TRIALS) * 100,
        avgFirstPayout,
        pAtLeast2: (reachedAtLeastTwo.length / TRIALS) * 100,
        avgSecondPayout,
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/lucidflex-150k-payout-depth-results.json");
}

main();
