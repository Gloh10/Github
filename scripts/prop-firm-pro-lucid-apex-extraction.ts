import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const MNQ_POINT_VALUE_USD = 2;
const TRIALS = 1000;

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
function sizeContracts(ddAmount: number, avgRiskPoints: number, maxContractsNQ: number): { pointValue: number; contracts: number; instrument: string; ddPct: number } {
  const oneNqContractRiskPct = (avgRiskPoints * NQ_POINT_VALUE_USD) / ddAmount;
  const useMicro = oneNqContractRiskPct > 0.2;
  const pointValue = useMicro ? MNQ_POINT_VALUE_USD : NQ_POINT_VALUE_USD;
  const targetRiskDollars = ddAmount / 6;
  const maxContracts = useMicro ? maxContractsNQ * 10 : maxContractsNQ;
  const contracts = Math.max(1, Math.min(maxContracts, Math.floor(targetRiskDollars / (avgRiskPoints * pointValue))));
  return { pointValue, contracts, instrument: useMicro ? "MNQ" : "NQ", ddPct: (avgRiskPoints * pointValue * contracts) / ddAmount };
}

interface TrialResult {
  busted: boolean;
  payoutCount: number;
  totalProtected: number;
  clearedCombine: boolean;
}

// ---------------------------------------------------------------------------
// MyFundedFutures PRO plan. Verified via search: sizes $50K-$150K, ~6% profit
// target, EOD trailing DD buffers $2,100/$3,100/$4,600 (50K/100K/150K), NO
// consistency rule at any stage, payout eligibility opens on a recurring
// ~14-CALENDAR-day cycle (not a winning-day count) with 80/20 split of full
// cycle profit and effectively no per-request cap (only a $100K cumulative
// cap across all Pro accounts firm-wide, non-binding for a single account
// here). Approximation disclosed: 14 calendar days ~= 10 trading days (5/7
// week ratio) since our data is trading-day granular after shuffling.
// ---------------------------------------------------------------------------
const MFF_PRO_TIERS = [
  { tier: "50K", accountSize: 50_000, combineTarget: 3_000, ddAmount: 2_100, maxContractsNQ: 10 },
  { tier: "100K", accountSize: 100_000, combineTarget: 6_000, ddAmount: 3_100, maxContractsNQ: 14 },
  { tier: "150K", accountSize: 150_000, combineTarget: 9_000, ddAmount: 4_600, maxContractsNQ: 15 },
];
const MFF_PRO_MIN_DAYS = 2;
const MFF_PRO_CYCLE_TRADING_DAYS = 10; // approximation of "14 calendar days"
const MFF_PRO_SPLIT = 0.8;

function runMffProTrial(shuffled: Trade[][], t: (typeof MFF_PRO_TIERS)[number], pointValue: number, contracts: number): TrialResult {
  let balance = t.accountSize;
  let peak = t.accountSize;
  let inCombine = true;
  let combineDays = 0;
  let cycleStartBalance = t.accountSize;
  let cycleDays = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= t.ddAmount) return { busted: true, payoutCount, totalProtected, clearedCombine };
    }

    if (inCombine) {
      combineDays++;
      const totalProfit = balance - t.accountSize;
      if (totalProfit >= t.combineTarget && combineDays >= MFF_PRO_MIN_DAYS) {
        inCombine = false;
        clearedCombine = true;
        cycleStartBalance = balance;
        peak = balance;
      }
      continue;
    }

    cycleDays++;
    const cycleProfit = balance - cycleStartBalance;
    if (cycleDays >= MFF_PRO_CYCLE_TRADING_DAYS && cycleProfit > 0) {
      const payoutAmount = MFF_PRO_SPLIT * cycleProfit;
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStartBalance = balance;
      cycleDays = 0;
      peak = balance;
    }
  }
  return { busted: false, payoutCount, totalProtected, clearedCombine };
}

// ---------------------------------------------------------------------------
// LucidFlex. Verified via search: sizes $25K-$150K, eval targets
// $1,250/$3,000/$6,000/$9,000, eval MLL $1,000/$2,000/$3,000/$4,500, EOD
// trailing that LOCKS PERMANENTLY once closing balance exceeds
// accountSize+MLL+$100 (floor then fixed at accountSize+$100 forever) --
// zero daily loss limit at either stage. Funded: 5 winning days, payout cap
// = 50% of balance up to $1,000/$2,000/$2,500/$3,000 by tier, $500 minimum,
// no consistency rule. Funded-stage DD assumed to reuse the eval MLL dollar
// figure with a fresh lock tracker anchored at combine-clear balance
// (disclosed approximation -- no separate funded DD figure was published).
// ---------------------------------------------------------------------------
const LUCIDFLEX_TIERS = [
  { tier: "25K", accountSize: 25_000, combineTarget: 1_250, ddAmount: 1_000, payoutCap: 1_000, maxContractsNQ: 4 },
  { tier: "50K", accountSize: 50_000, combineTarget: 3_000, ddAmount: 2_000, payoutCap: 2_000, maxContractsNQ: 10 },
  { tier: "100K", accountSize: 100_000, combineTarget: 6_000, ddAmount: 3_000, payoutCap: 2_500, maxContractsNQ: 14 },
  { tier: "150K", accountSize: 150_000, combineTarget: 9_000, ddAmount: 4_500, payoutCap: 3_000, maxContractsNQ: 15 },
];
const LUCIDFLEX_WINNING_DAYS_NEEDED = 5;
const LUCIDFLEX_MIN_PAYOUT = 500;

function runLucidFlexTrial(shuffled: Trade[][], t: (typeof LUCIDFLEX_TIERS)[number], pointValue: number, contracts: number): TrialResult {
  let balance = t.accountSize;
  let inCombine = true;
  let phaseAnchor = t.accountSize; // balance the current phase's DD tracker is anchored to
  let floor = t.accountSize - t.ddAmount;
  let locked = false;
  let combineDays = 0;
  let cycleStartBalance = t.accountSize;
  let winningDaysThisCycle = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { busted: true, payoutCount, totalProtected, clearedCombine };
    }
    // EOD-only floor update (lock-at-close mechanic).
    if (!locked) {
      if (balance > phaseAnchor + t.ddAmount + 100) {
        locked = true;
        floor = phaseAnchor + 100;
      } else {
        floor = Math.max(floor, balance - t.ddAmount);
      }
    }

    if (inCombine) {
      combineDays++;
      const totalProfit = balance - t.accountSize;
      if (totalProfit >= t.combineTarget && combineDays >= 1) {
        inCombine = false;
        clearedCombine = true;
        cycleStartBalance = balance;
        phaseAnchor = balance;
        floor = balance - t.ddAmount;
        locked = false;
      }
      continue;
    }

    if (dayPnl > 0) winningDaysThisCycle++;
    const cycleProfit = balance - cycleStartBalance;
    if (winningDaysThisCycle >= LUCIDFLEX_WINNING_DAYS_NEEDED && cycleProfit > 0) {
      const raw = Math.min(t.payoutCap, 0.5 * balance);
      const payoutAmount = Math.min(raw, cycleProfit);
      if (payoutAmount >= LUCIDFLEX_MIN_PAYOUT) {
        balance -= payoutAmount;
        totalProtected += payoutAmount;
        payoutCount++;
        cycleStartBalance = balance;
        winningDaysThisCycle = 0;
        // Payout does not reset the lock -- once locked, the floor stays put permanently.
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - t.ddAmount;
        }
      }
    }
  }
  return { busted: false, payoutCount, totalProtected, clearedCombine };
}

// ---------------------------------------------------------------------------
// Apex Trader Funding, 150K tier (largest available since Apex discontinued
// 250K/300K in its March 2026 "4.0" restructuring). Verified via search:
// $5,000 trailing drawdown with a SAFETY NET at accountSize+$5,000+$100
// ($155,100) -- once peak balance crosses that, the floor locks permanently
// at accountSize+$100 ($150,100) for the life of the account (combine and
// PA/funded share one continuous tracker anchored to the original account
// size, per Apex's documented mechanic). No consistency rule in eval.
// Payout stage: six-step weekly ladder ($2,500 / $3,000x3 / $4,000 / $5,000,
// $20,500 total), each requiring 5 qualifying trading days since the last
// payout, $500 minimum profit, and a 50% consistency rule (best single day
// <= 50% of cycle profit). Limits are removed after the 6th payout; beyond
// that we fall back to the $5,000 cap as an approximation (unlikely to be
// reached given the ~18 unique days of underlying data).
// ---------------------------------------------------------------------------
const APEX_150K = { tier: "150K", accountSize: 150_000, combineTarget: 9_000, ddAmount: 5_000, maxContractsNQ: 17 };
const APEX_LADDER_CAPS = [2_500, 3_000, 3_000, 3_000, 4_000, 5_000];
const APEX_MIN_DAYS = 5;
const APEX_MIN_PROFIT = 500;
const APEX_CONSISTENCY_PCT = 0.5;

function runApex150kTrial(shuffled: Trade[][], pointValue: number, contracts: number): TrialResult {
  const t = APEX_150K;
  let balance = t.accountSize;
  let peak = t.accountSize;
  let floor = t.accountSize - t.ddAmount;
  let locked = false;
  let inCombine = true;
  let combineDays = 0;
  let cycleStartBalance = t.accountSize;
  let cycleDailyPnL: number[] = [];
  let payoutCount = 0;
  let totalProtected = 0;
  let clearedCombine = false;

  for (const dayTrades of shuffled) {
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      if (balance < floor) return { busted: true, payoutCount, totalProtected, clearedCombine };
      if (!locked) {
        if (peak >= t.accountSize + t.ddAmount + 100) {
          locked = true;
          floor = t.accountSize + 100;
        } else {
          floor = Math.max(floor, peak - t.ddAmount);
        }
      }
    }

    if (inCombine) {
      combineDays++;
      const totalProfit = balance - t.accountSize;
      if (totalProfit >= t.combineTarget && combineDays >= 1) {
        inCombine = false;
        clearedCombine = true;
        cycleStartBalance = balance;
      }
      continue;
    }

    cycleDailyPnL.push(dayPnl);
    const cycleProfit = balance - cycleStartBalance;
    const daysOk = cycleDailyPnL.length >= APEX_MIN_DAYS;
    const bestDay = Math.max(...cycleDailyPnL);
    const consistencyOk = cycleProfit <= 0 || bestDay <= APEX_CONSISTENCY_PCT * cycleProfit;
    if (daysOk && cycleProfit >= APEX_MIN_PROFIT && consistencyOk) {
      const cap = APEX_LADDER_CAPS[Math.min(payoutCount, APEX_LADDER_CAPS.length - 1)]!;
      const payoutAmount = Math.min(cap, cycleProfit);
      balance -= payoutAmount;
      totalProtected += payoutAmount;
      payoutCount++;
      cycleStartBalance = balance;
      cycleDailyPnL = [];
      // Safety-net floor is untouched by payouts -- it stays anchored to the
      // original account size for the account's whole life (or stays locked).
    }
  }
  return { busted: false, payoutCount, totalProtected, clearedCombine };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const trades = buildBestStrategyTrades(nq5m);
  const avgRiskPoints = trades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / trades.length;

  const dayBucketsMap = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(nq5m[t.barIndex]!.t);
    if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
    dayBucketsMap.get(key)!.push(t);
  }
  const dayBuckets = [...dayBucketsMap.values()];

  console.log(`GOAL: maximize expected money extracted, indifferent to account survival -- front-loaded withdrawals.`);
  console.log(`New firms/plans this run: MyFundedFutures PRO, LucidFlex (all tiers), Apex 150K.`);
  console.log(`All rule figures below were pulled from direct web verification this session, not assumed from memory.\n`);

  const shuffledTrials: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) shuffledTrials.push(shuffle(dayBuckets));

  const summary: { firm: string; tier: string; instrument: string; contracts: number; avgProtected: number; bustRate: number; clearRate: number; avgPayouts: number; confidenceNote: string }[] = [];

  console.log("=".repeat(100));
  console.log("MyFundedFutures PRO");
  console.log("=".repeat(100));
  for (const t of MFF_PRO_TIERS) {
    const { pointValue, contracts, instrument, ddPct } = sizeContracts(t.ddAmount, avgRiskPoints, t.maxContractsNQ);
    const results = shuffledTrials.map((s) => runMffProTrial(s, t, pointValue, contracts));
    const cleared = results.filter((r) => r.clearedCombine);
    const busted = results.filter((r) => r.busted);
    const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
    console.log(`${t.tier.padEnd(6)} ${instrument.padEnd(4)} ${contracts} contract(s) (${(ddPct * 100).toFixed(1)}% of DD budget)   clearRate=${((cleared.length / TRIALS) * 100).toFixed(1)}%   bustRate=${((busted.length / TRIALS) * 100).toFixed(1)}%   avgPayouts=${avgPayouts.toFixed(2)}   expectedProtected=$${avgProtected.toFixed(0)}`);
    summary.push({
      firm: "MyFundedFutures Pro",
      tier: t.tier,
      instrument,
      contracts,
      avgProtected,
      bustRate: (busted.length / TRIALS) * 100,
      clearRate: (cleared.length / TRIALS) * 100,
      avgPayouts,
      confidenceNote: "LOWER CONFIDENCE: 14-calendar-day payout cycle approximated as 10 trading days; DD dollar figures verified but lock-mechanic (if any) not confirmed, modeled as continuously trailing.",
    });
  }

  console.log("\n" + "=".repeat(100));
  console.log("LucidFlex");
  console.log("=".repeat(100));
  for (const t of LUCIDFLEX_TIERS) {
    const { pointValue, contracts, instrument, ddPct } = sizeContracts(t.ddAmount, avgRiskPoints, t.maxContractsNQ);
    const results = shuffledTrials.map((s) => runLucidFlexTrial(s, t, pointValue, contracts));
    const cleared = results.filter((r) => r.clearedCombine);
    const busted = results.filter((r) => r.busted);
    const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
    console.log(`${t.tier.padEnd(6)} ${instrument.padEnd(4)} ${contracts} contract(s) (${(ddPct * 100).toFixed(1)}% of DD budget)   clearRate=${((cleared.length / TRIALS) * 100).toFixed(1)}%   bustRate=${((busted.length / TRIALS) * 100).toFixed(1)}%   avgPayouts=${avgPayouts.toFixed(2)}   expectedProtected=$${avgProtected.toFixed(0)}`);
    summary.push({
      firm: "LucidFlex",
      tier: t.tier,
      instrument,
      contracts,
      avgProtected,
      bustRate: (busted.length / TRIALS) * 100,
      clearRate: (cleared.length / TRIALS) * 100,
      avgPayouts,
      confidenceNote: "MEDIUM-HIGH CONFIDENCE: EOD lock-at-close mechanic and payout caps directly verified. Funded-stage DD amount assumed to reuse the eval MLL figure (not separately published).",
    });
  }

  console.log("\n" + "=".repeat(100));
  console.log("Apex Trader Funding -- 150K (largest tier now offered; 250K/300K discontinued)");
  console.log("=".repeat(100));
  {
    const t = APEX_150K;
    const { pointValue, contracts, instrument, ddPct } = sizeContracts(t.ddAmount, avgRiskPoints, t.maxContractsNQ);
    const results = shuffledTrials.map((s) => runApex150kTrial(s, pointValue, contracts));
    const cleared = results.filter((r) => r.clearedCombine);
    const busted = results.filter((r) => r.busted);
    const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
    console.log(`${t.tier.padEnd(6)} ${instrument.padEnd(4)} ${contracts} contract(s) (${(ddPct * 100).toFixed(1)}% of DD budget)   clearRate=${((cleared.length / TRIALS) * 100).toFixed(1)}%   bustRate=${((busted.length / TRIALS) * 100).toFixed(1)}%   avgPayouts=${avgPayouts.toFixed(2)}   expectedProtected=$${avgProtected.toFixed(0)}`);
    summary.push({
      firm: "Apex Trader Funding",
      tier: t.tier,
      instrument,
      contracts,
      avgProtected,
      bustRate: (busted.length / TRIALS) * 100,
      clearRate: (cleared.length / TRIALS) * 100,
      avgPayouts,
      confidenceNote: "MEDIUM CONFIDENCE: $5,000 safety-net DD and 6-step payout ladder directly verified. Assumed combine and PA share one continuous lock-anchored DD tracker; funded-stage DD amount not separately published.",
    });
  }

  // Reference figures from prior verified runs (not recomputed here), for the combined ranking.
  const priorReference = [
    { firm: "Topstep", tier: "150K", instrument: "NQ", contracts: 1, avgProtected: null as number | null, bustRate: null as number | null, clearRate: null as number | null, avgPayouts: null as number | null, note: "see data/prop-firm-150k-extraction-comparison-results.json" },
  ];

  console.log("\n" + "=".repeat(100));
  console.log("RANKED -- this run's firms/plans only, by expected total protected $ (front-loaded, indifferent to survival)");
  console.log("=".repeat(100));
  [...summary]
    .sort((a, b) => b.avgProtected - a.avgProtected)
    .forEach((s, i) =>
      console.log(`${i + 1}. ${(s.firm + " " + s.tier).padEnd(28)} $${s.avgProtected.toFixed(0).padStart(6)}   bustRate=${s.bustRate.toFixed(1)}%   clearRate=${s.clearRate.toFixed(1)}%   avgPayouts=${s.avgPayouts.toFixed(2)}`),
    );

  console.log("\nFor comparison, previously verified results (not rerun here):");
  console.log("  MyFundedFutures Core: 25K=$1,060 (17.5% bust)  50K=$904 (36.7% bust)  100K=$923 (33.3% bust)  150K=$1,082 (2.5% bust)");
  console.log("  Topstep 150K / Alpha Futures 150K: see data/prop-firm-150k-extraction-comparison-results.json");

  writeFileSync(
    "data/prop-firm-pro-lucid-apex-extraction-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, summary, priorReferenceNote: priorReference[0]!.note }, null, 2),
  );
  console.log("\nFull results written to data/prop-firm-pro-lucid-apex-extraction-results.json");
}

main();
