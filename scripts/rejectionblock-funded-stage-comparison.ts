import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithPointsTrail } from "../src/backtest/engine.js";
import { nyDateKey } from "../src/backtest/nyTime.js";
import { rejectionBlock } from "../src/backtest/strategies.js";
import type { Bar, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const MNQ_POINT_VALUE_USD = 2;
const TRIALS = 1000;

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
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

// -- Build the validated rejection-block trade list: 1h NQ, BE@0pt, trail start 5pt / distance 2pt.
const nq1h = loadBars("data/nq-1h.json");
const rbSignals = rejectionBlock(nq1h, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
const rbTrades = simulateTradesWithPointsTrail(nq1h, rbSignals, { breakevenTriggerPoints: 0, trailStartPoints: 5, trailDistancePoints: 2 });
const rbStats = computeStats(rbTrades, buildEquityCurve(nq1h, rbTrades));
const avgRiskPoints = rbTrades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / rbTrades.length;

const dayBucketsMap = new Map<string, Trade[]>();
for (const t of rbTrades) {
  const key = nyDateKey(nq1h[t.barIndex]!.t);
  if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
  dayBucketsMap.get(key)!.push(t);
}
const dayBuckets = [...dayBucketsMap.values()];

// ---------------------------------------------------------------------------
// FUNDED-STAGE ONLY simulations -- the eval is assumed already cleared, so
// each trial starts fresh at the funded balance with a fresh DD tracker.
// This isolates "how fast does this strategy generate payouts once funded,"
// which is the question that matters after the eval is done.
// ---------------------------------------------------------------------------

// -- LucidFlex 150K funded stage (rules verified from the user's own screenshots).
const LUCID_DD = 4_500;
const LUCID_PAYOUT_CAP = 3_000;
const LUCID_WIN_DAY_THRESHOLD = 250;
const LUCID_WINNING_DAYS_NEEDED = 5;
const LUCID_MIN_PAYOUT = 500;
const LUCID_MAX_PAYOUTS = 5;

interface FundedResult {
  status: "busted" | "ran_out_of_data" | "graduated_or_capped";
  payoutCount: number;
  totalProtected: number;
  daysToFirstPayout: number | null;
}

function runLucidFunded(shuffled: Trade[][], pointValue: number, contracts: number): FundedResult {
  const fundedStart = 150_000; // arbitrary anchor -- only relative P&L matters for a funded-stage-only sim
  let balance = fundedStart;
  let phaseAnchor = fundedStart;
  let floor = fundedStart - LUCID_DD;
  let locked = false;
  let cycleStart = fundedStart;
  let winningDaysThisCycle = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let daysToFirstPayout: number | null = null;
  let dayIndex = 0;

  for (const dayTrades of shuffled) {
    dayIndex++;
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) return { status: "busted", payoutCount, totalProtected, daysToFirstPayout };
    }
    if (!locked) {
      if (balance > phaseAnchor + LUCID_DD + 100) {
        locked = true;
        floor = phaseAnchor + 100;
      } else {
        floor = Math.max(floor, balance - LUCID_DD);
      }
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
        if (payoutCount >= LUCID_MAX_PAYOUTS) return { status: "graduated_or_capped", payoutCount, totalProtected, daysToFirstPayout };
        cycleStart = balance;
        winningDaysThisCycle = 0;
        if (!locked) {
          phaseAnchor = balance;
          floor = balance - LUCID_DD;
        }
      }
    }
  }
  return { status: "ran_out_of_data", payoutCount, totalProtected, daysToFirstPayout };
}

// -- MyFundedFutures Pro 150K funded stage (verified: ~14 calendar days ~= 10 trading days
// cycle, no consistency rule, 80% split, effectively uncapped per-request).
const MFF_PRO_DD = 4_600;
const MFF_PRO_CYCLE_TRADING_DAYS = 10;
const MFF_PRO_SPLIT = 0.8;

function runMffProFunded(shuffled: Trade[][], pointValue: number, contracts: number): FundedResult {
  const fundedStart = 150_000;
  let balance = fundedStart;
  let peak = fundedStart;
  let cycleStart = fundedStart;
  let cycleDays = 0;
  let payoutCount = 0;
  let totalProtected = 0;
  let daysToFirstPayout: number | null = null;
  let dayIndex = 0;

  for (const dayTrades of shuffled) {
    dayIndex++;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * pointValue * contracts;
      balance += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= MFF_PRO_DD) return { status: "busted", payoutCount, totalProtected, daysToFirstPayout };
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
  return { status: "ran_out_of_data", payoutCount, totalProtected, daysToFirstPayout };
}

function main() {
  console.log("=".repeat(100));
  console.log("Rejection block (1h NQ, BE@0pt/trail 5pt-2pt) -- funded-stage-only simulation");
  console.log("=".repeat(100));
  console.log(`Underlying strategy stats: ${rbTrades.length} trades, ${(rbStats.winRate * 100).toFixed(1)}% win rate, ${dayBuckets.length} distinct NY trading days`);
  console.log(`(data spans ${new Date(nq1h[0]!.t * 1000).toISOString().slice(0, 10)} to ${new Date(nq1h[nq1h.length - 1]!.t * 1000).toISOString().slice(0, 10)} -- 1h bars go back much further than the 5-min data)`);
  console.log(`Avg stop distance: ${avgRiskPoints.toFixed(1)} NQ points ($${(avgRiskPoints * NQ_POINT_VALUE_USD).toFixed(0)}/contract at full size)\n`);

  const shuffledTrials: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) shuffledTrials.push(shuffle(dayBuckets));

  const summary: Record<string, unknown>[] = [];

  for (const [label, ddAmount, maxContractsNQ, runFn] of [
    ["LucidFlex 150K (funded stage)", LUCID_DD, 15, runLucidFunded],
    ["MyFundedFutures Pro 150K (funded stage)", MFF_PRO_DD, 15, runMffProFunded],
  ] as const) {
    const { pointValue, contracts, instrument, ddPct } = sizeContracts(ddAmount, avgRiskPoints, maxContractsNQ);
    const results = shuffledTrials.map((s) => runFn(s, pointValue, contracts));
    const busted = results.filter((r) => r.status === "busted");
    const graduated = results.filter((r) => r.status === "graduated_or_capped");
    const avgProtected = results.reduce((s, r) => s + r.totalProtected, 0) / results.length;
    const avgPayouts = results.reduce((s, r) => s + r.payoutCount, 0) / results.length;
    const withFirstPayout = results.filter((r) => r.daysToFirstPayout !== null);
    const avgDaysToFirstPayout = withFirstPayout.length > 0 ? withFirstPayout.reduce((s, r) => s + r.daysToFirstPayout!, 0) / withFirstPayout.length : NaN;
    const pAtLeastOnePayout = (results.filter((r) => r.payoutCount >= 1).length / TRIALS) * 100;

    console.log("-".repeat(100));
    console.log(`${label} -- sized in ${instrument}, ${contracts} contract(s) (${(ddPct * 100).toFixed(1)}% of DD budget)`);
    console.log("-".repeat(100));
    console.log(`Bust rate: ${((busted.length / TRIALS) * 100).toFixed(1)}%   Hit payout cap/graduated: ${((graduated.length / TRIALS) * 100).toFixed(1)}%`);
    console.log(`Avg payouts landed: ${avgPayouts.toFixed(2)}   P(at least 1 payout): ${pAtLeastOnePayout.toFixed(1)}%`);
    console.log(`Avg trading days to FIRST payout (when reached): ${avgDaysToFirstPayout.toFixed(1)}`);
    console.log(`Expected total protected (all trials): $${avgProtected.toFixed(0)}\n`);

    summary.push({ label, instrument, contracts, ddPct: ddPct * 100, bustRate: (busted.length / TRIALS) * 100, avgPayouts, pAtLeastOnePayout, avgDaysToFirstPayout, avgProtected });
  }

  console.log("=".repeat(100));
  console.log("FOR COMPARISON -- the flagship (C1) strategy's already-known funded-stage numbers (5-min NQ, R=5):");
  console.log("=".repeat(100));
  console.log("  LucidFlex 150K funded stage: ~1.0 avg payouts within the available 18-day data pool, avg payout ~$3,000, P(>=1 payout)=98.9%");
  console.log("  MyFundedFutures Pro 150K funded stage: bust rate 1.6%, avg payouts 0.72, expected protected $7,063 (bounded by the same 18-day pool)");
  console.log("  NOTE: the rejection-block numbers above are NOT bounded by that same 18-day pool -- the 1h dataset spans ~10 months,");
  console.log("  so its Monte Carlo trials can draw far more trading-day combinations. That's a genuinely richer test, not just a lucky one.");

  writeFileSync("data/rejectionblock-funded-stage-comparison-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, underlyingStats: rbStats, distinctDays: dayBuckets.length, summary }, null, 2));
  console.log("\nFull results written to data/rejectionblock-funded-stage-comparison-results.json");
}

main();
