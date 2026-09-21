import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 1000;
const CONTRACTS = 1;

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

interface FundedModel {
  firm: string;
  accountSize: number;
  combineTarget: number;
  combineMLL: number;
  combineDLL: number | null;
  combineConsistencyPct: number | null;
  combineMinDays: number;
  winningDayThreshold: number; // $ a day must clear to count as a "winning day"; 0 = any positive day
  winningDaysNeeded: number;
  fundedConsistencyPct: number | null;
  fundedMinDaysForConsistency: number;
  payoutFraction: number;
  payoutCap: number | null;
  postPayoutBehavior: "resetToZero" | "continueTrailing";
  confidenceNote: string;
}

// Combine-phase numbers are solidly documented for all three. Funded/payout-stage mechanics are
// explicit and detailed for Topstep; for Alpha Futures and MyFundedFutures, the available sources
// describe the drawdown as continuing to trail normally through withdrawals (no stated "resets to
// $0" event like Topstep's), but this is inferred from less exhaustive documentation than Topstep's.
const MODELS: FundedModel[] = [
  {
    firm: "Topstep",
    accountSize: 150_000,
    combineTarget: 9_000,
    combineMLL: 4_500,
    combineDLL: 3_000,
    combineConsistencyPct: 0.55,
    combineMinDays: 5,
    winningDayThreshold: 150,
    winningDaysNeeded: 5,
    fundedConsistencyPct: null, // modeling the Standard path specifically here
    fundedMinDaysForConsistency: 0,
    payoutFraction: 0.5,
    payoutCap: 10_000,
    postPayoutBehavior: "resetToZero",
    confidenceNote: "Explicitly documented: MLL resets to $0 (must maintain balance) after every payout.",
  },
  {
    firm: "Alpha Futures (Advanced)",
    accountSize: 150_000,
    combineTarget: 12_000,
    combineMLL: 5_250,
    combineDLL: null,
    combineConsistencyPct: 0.5,
    combineMinDays: 1,
    winningDayThreshold: 200,
    winningDaysNeeded: 5,
    fundedConsistencyPct: null, // Advanced funded accounts: no consistency rule
    fundedMinDaysForConsistency: 0,
    payoutFraction: 0.5,
    payoutCap: null, // no dollar cap found in available sources, just 50% of profit per request
    postPayoutBehavior: "continueTrailing",
    confidenceNote: "LOWER CONFIDENCE: sources describe EOD trailing DD 'advancing on closing balance,' with no stated reset-to-zero event, but this is inferred, not as explicitly documented as Topstep's rule.",
  },
  {
    firm: "MyFundedFutures (Core)",
    accountSize: 150_000,
    combineTarget: 9_000,
    combineMLL: 4_500,
    combineDLL: null,
    combineConsistencyPct: 0.5,
    combineMinDays: 2,
    winningDayThreshold: 0, // no explicit per-day $ threshold found; any positive day counts (disclosed assumption)
    winningDaysNeeded: 5,
    fundedConsistencyPct: null, // Core funded stage: consistency rule dropped entirely
    fundedMinDaysForConsistency: 0,
    payoutFraction: 1.0, // "capped at $5,000 per cycle" -- modeled as take-the-cap-or-all-profit, whichever is less
    payoutCap: 5_000,
    postPayoutBehavior: "continueTrailing",
    confidenceNote: "LOWER CONFIDENCE: 3% EOD trailing DD stated to continue through funded stage, no stated reset-to-zero event, but less explicitly documented than Topstep's rule. Winning-day $ threshold not found; assumed any positive day qualifies.",
  },
];

interface TrialResult {
  busted: boolean;
  payoutCount: number;
  totalProtected: number;
  clearedCombine: boolean;
}

function runOneTrial(shuffled: Trade[][], model: FundedModel): TrialResult {
  let balance = model.accountSize;
  let peak = model.accountSize;
  let inCombine = true;
  let combineWinDays = 0;
  const combineDailyPnL: number[] = [];
  let floor = -Infinity; // used only for resetToZero post-payout mode
  let winningDaysThisCycle = 0;
  let cycleStartBalance = model.accountSize;
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const t of dayTrades) {
      const riskPoints = Math.abs(t.entry - t.stop);
      const pnl = t.rMultiple * riskPoints * NQ_POINT_VALUE_USD * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);

      if (inCombine) {
        if (peak - balance >= model.combineMLL) return { busted: true, payoutCount, totalProtected, clearedCombine };
      } else if (model.postPayoutBehavior === "resetToZero") {
        if (balance < floor) return { busted: true, payoutCount, totalProtected, clearedCombine };
      } else {
        if (peak - balance >= model.combineMLL) return { busted: true, payoutCount, totalProtected, clearedCombine };
      }
    }

    if (model.combineDLL !== null && inCombine && dayPnl <= -model.combineDLL) {
      return { busted: true, payoutCount, totalProtected, clearedCombine };
    }

    if (inCombine) {
      if (dayPnl >= model.winningDayThreshold) combineWinDays++;
      combineDailyPnL.push(dayPnl);
      const totalProfit = balance - model.accountSize;
      const daysOk = combineWinDays >= model.combineMinDays || combineDailyPnL.length >= model.combineMinDays;
      let consistencyOk = true;
      if (model.combineConsistencyPct !== null && combineDailyPnL.length > 0) {
        consistencyOk = Math.max(...combineDailyPnL) <= model.combineConsistencyPct * Math.max(totalProfit, 1);
      }
      if (totalProfit >= model.combineTarget && daysOk && consistencyOk) {
        inCombine = false;
        clearedCombine = true;
        cycleStartBalance = balance;
        peak = balance;
      }
      continue;
    }

    // Funded/payout stage.
    if (dayPnl >= model.winningDayThreshold) winningDaysThisCycle++;
    const cycleProfit = balance - cycleStartBalance;
    const eligible = winningDaysThisCycle >= model.winningDaysNeeded && cycleProfit > 0;

    if (eligible) {
      const rawPayout = model.payoutFraction * cycleProfit;
      const payoutAmount = model.payoutCap !== null ? Math.min(model.payoutCap, rawPayout) : rawPayout;
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStartBalance = balance;
      winningDaysThisCycle = 0;
      if (model.postPayoutBehavior === "resetToZero") {
        floor = balance;
      } else {
        peak = balance; // trailing DD continues, anchored fresh at the post-payout balance
      }
    }
  }

  return { busted: false, payoutCount, totalProtected, clearedCombine };
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

  console.log(`GOAL: maximize expected money extracted, indifferent to account survival -- front-loaded withdrawals (max payout every eligible cycle) across three 150K accounts.\n`);

  const shuffledTrials: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) shuffledTrials.push(shuffle(dayBuckets));

  const summary: { firm: string; avgProtected: number; bustRate: number; clearRate: number; avgPayouts: number }[] = [];

  for (const model of MODELS) {
    const results = shuffledTrials.map((s) => runOneTrial(s, model));
    const cleared = results.filter((r) => r.clearedCombine);
    const busted = results.filter((r) => r.busted);
    const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;

    console.log("=".repeat(95));
    console.log(`${model.firm} -- $${model.accountSize.toLocaleString()}`);
    console.log("=".repeat(95));
    console.log(`Confidence note: ${model.confidenceNote}`);
    console.log(`Cleared the combine: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   Eventually busted: ${((busted.length / TRIALS) * 100).toFixed(1)}%`);
    console.log(`Avg payouts taken: ${avgPayouts.toFixed(2)}   EXPECTED TOTAL PROTECTED (all trials): $${avgProtected.toFixed(0)}\n`);

    summary.push({ firm: model.firm, avgProtected, bustRate: (busted.length / TRIALS) * 100, clearRate: (cleared.length / TRIALS) * 100, avgPayouts });
  }

  console.log("=".repeat(95));
  console.log("RANKED by expected total protected $ (front-loaded, indifferent to survival)");
  console.log("=".repeat(95));
  [...summary]
    .sort((a, b) => b.avgProtected - a.avgProtected)
    .forEach((s, i) => console.log(`${i + 1}. ${s.firm.padEnd(28)} $${s.avgProtected.toFixed(0).padStart(6)}   bustRate=${s.bustRate.toFixed(1)}%   clearRate=${s.clearRate.toFixed(1)}%   avgPayouts=${s.avgPayouts.toFixed(2)}`));

  writeFileSync("data/prop-firm-150k-extraction-comparison-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, models: MODELS, summary }, null, 2));
  console.log("\nFull results written to data/prop-firm-150k-extraction-comparison-results.json");
}

main();
