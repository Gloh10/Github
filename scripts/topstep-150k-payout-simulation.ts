import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 1000;
const ACCOUNT_SIZE = 150_000;
const PRE_PAYOUT_MLL = 4_500; // published Topstep 150K Max Loss Limit ("The One Rule")
const DAILY_LOSS_LIMIT = 3_000; // "Responsible Trading Advantage" daily loss limit, combine phase
const CONTRACTS = 1; // matches the sizing used in the eval Monte Carlo (1 contract at 150K)
const STANDARD_PAYOUT_CAP = 10_000; // Option 1: Standard -- DOUBLE payout cap, per user-supplied current rules
const CONSISTENCY_PAYOUT_CAP = 12_000; // Option 2: Consistency -- DOUBLE payout cap
const STANDARD_WIN_DAY_THRESHOLD = 150; // "winning day" = net PnL >= $150
const STANDARD_WIN_DAYS_NEEDED = 5;
const CONSISTENCY_MIN_DAYS = 3;
const CONSISTENCY_PCT = 0.4; // best single day <= 40% of total profit

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

type Result =
  | { outcome: "BUSTED_PRE_PAYOUT"; day: number }
  | { outcome: "NEVER_REACHED_PAYOUT_ELIGIBILITY"; day: number }
  | { outcome: "BUSTED_POST_PAYOUT"; day: number; eligibleDay: number; eligiblePath: string; payoutAmount: number }
  | { outcome: "SURVIVED_TO_END_OF_DATA"; day: number; eligibleDay: number; eligiblePath: string; payoutAmount: number; finalBalance: number };

function runOneTrial(shuffled: Trade[][], path: "standard" | "consistency", payoutFraction: number): Result {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let winningDaysStandard = 0;
  const dailyPnLForConsistency: number[] = [];
  let payoutTaken = false;
  let postPayoutFloor = 0;
  let eligibleDay = -1;
  let eligiblePath = "";
  let payoutAmount = 0;
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
        if (peak - balance >= PRE_PAYOUT_MLL) return { outcome: "BUSTED_PRE_PAYOUT", day: dayIndex };
      } else {
        if (balance < postPayoutFloor) return { outcome: "BUSTED_POST_PAYOUT", day: dayIndex, eligibleDay, eligiblePath, payoutAmount };
      }
    }

    if (!payoutTaken && dayPnl <= -DAILY_LOSS_LIMIT) return { outcome: "BUSTED_PRE_PAYOUT", day: dayIndex };

    if (!payoutTaken) {
      if (dayPnl >= STANDARD_WIN_DAY_THRESHOLD) winningDaysStandard++;
      dailyPnLForConsistency.push(dayPnl);

      const totalProfit = balance - ACCOUNT_SIZE;
      const standardEligible = winningDaysStandard >= STANDARD_WIN_DAYS_NEEDED;
      let consistencyEligible = false;
      if (dailyPnLForConsistency.length >= CONSISTENCY_MIN_DAYS && totalProfit > 0) {
        const bestDay = Math.max(...dailyPnLForConsistency);
        consistencyEligible = bestDay <= CONSISTENCY_PCT * totalProfit;
      }

      const eligibleNow = path === "standard" ? standardEligible : consistencyEligible;
      if (eligibleNow && totalProfit > 0) {
        const cap = path === "standard" ? STANDARD_PAYOUT_CAP : CONSISTENCY_PAYOUT_CAP;
        payoutAmount = Math.min(cap, payoutFraction * totalProfit);
        balance -= payoutAmount;
        postPayoutFloor = balance; // MLL resets to $0 buffer -- balance can never dip below this again
        payoutTaken = true;
        eligibleDay = dayIndex;
        eligiblePath = path;
      }
    }
  }

  if (!payoutTaken) return { outcome: "NEVER_REACHED_PAYOUT_ELIGIBILITY", day: dayIndex };
  return { outcome: "SURVIVED_TO_END_OF_DATA", day: dayIndex, eligibleDay, eligiblePath, payoutAmount, finalBalance: balance };
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

  console.log(`Topstep 150K funded/payout-stage simulation, using the exact user-supplied current rules.`);
  console.log(`Pre-payout: Max Loss Limit $${PRE_PAYOUT_MLL} ("The One Rule"), Daily Loss Limit $${DAILY_LOSS_LIMIT}.`);
  console.log(`Standard path: ${STANDARD_WIN_DAYS_NEEDED} days >= $${STANDARD_WIN_DAY_THRESHOLD} net, maintain balance between payouts, $${STANDARD_PAYOUT_CAP.toLocaleString()} payout cap.`);
  console.log(`Consistency path: ${CONSISTENCY_MIN_DAYS}+ days (>=1 trade/day), best day <= ${CONSISTENCY_PCT * 100}% of total profit, $${CONSISTENCY_PAYOUT_CAP.toLocaleString()} payout cap.`);
  console.log(`After the first payout on either path: Max Loss Limit resets to $0 (balance can never dip below the post-payout level again).`);
  console.log(`Path is chosen once at funded-account activation, not switched opportunistically -- simulating both separately.`);
  console.log(`CAVEAT: reuses the same 18 historical trading days as a proxy for "future" funded-account days (the full extent of available 5-min data). Real funded trading would happen on genuinely new days.\n`);

  console.log(
    `Testing whether taking a SMALLER payout (well under the 50%-of-profit max) reduces the post-payout bust rate.\n` +
      `Note on the mechanics: the $0 buffer is anchored to your balance at the MOMENT of payout, whatever that balance is.\n` +
      `Bust = does subsequent P&L ever go negative relative to that moment -- a question about the trade sequence only,\n` +
      `not about how many dollars you withdrew. So mathematically, payout size should NOT change the post-payout bust\n` +
      `rate under this specific rule; testing empirically to confirm rather than just asserting it.\n`,
  );

  // Pre-generate the shuffled day-orders ONCE, reused across every path/payoutFraction combo below --
  // an apples-to-apples paired comparison, isolating the effect of payout size from Monte Carlo noise.
  const shuffledTrials: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) shuffledTrials.push(shuffle(dayBuckets));

  for (const path of ["standard", "consistency"] as const) {
    for (const payoutFraction of [0.5, 0.25, 0.1, 0.05]) {
      const outcomes: Result[] = [];
      for (let i = 0; i < TRIALS; i++) outcomes.push(runOneTrial(shuffledTrials[i]!, path, payoutFraction));

      const bustedPre = outcomes.filter((r) => r.outcome === "BUSTED_PRE_PAYOUT").length;
      const bustedPost = outcomes.filter((r) => r.outcome === "BUSTED_POST_PAYOUT").length;
      const survived = outcomes.filter((r) => r.outcome === "SURVIVED_TO_END_OF_DATA").length;
      const reachedPayout = outcomes.filter((r): r is Extract<Result, { outcome: "BUSTED_POST_PAYOUT" | "SURVIVED_TO_END_OF_DATA" }> => r.outcome === "BUSTED_POST_PAYOUT" || r.outcome === "SURVIVED_TO_END_OF_DATA");
      const avgPayoutAmount = reachedPayout.length > 0 ? reachedPayout.reduce((s, r) => s + r.payoutAmount, 0) / reachedPayout.length : NaN;
      const postPayoutBustRate = reachedPayout.length > 0 ? (bustedPost / reachedPayout.length) * 100 : NaN;

      console.log(
        `${path.padEnd(12)} payoutFraction=${payoutFraction.toString().padStart(4)}  avgPayout=$${avgPayoutAmount.toFixed(0).padStart(6)}  ` +
          `bustedPre=${((bustedPre / TRIALS) * 100).toFixed(1)}%  postPayoutBust=${postPayoutBustRate.toFixed(1).padStart(5)}%  survived=${((survived / TRIALS) * 100).toFixed(1)}%`,
      );
    }
    console.log("");
  }

  writeFileSync(
    "data/topstep-150k-payout-simulation-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, note: "run per-path with corrected user-supplied rules; see console output" }, null, 2),
  );
  console.log("Full run complete.");
}

main();
