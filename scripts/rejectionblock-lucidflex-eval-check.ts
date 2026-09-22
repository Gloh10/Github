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

// LucidFlex 150K eval, sized the same way as the funded-stage test (4 MNQ contracts, 16.1% of DD budget).
const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500;
const EVAL_CONSISTENCY_PCT = 0.5;
const CONTRACTS = 4;
const POINT_VALUE = MNQ_POINT_VALUE_USD;

interface EvalResult {
  status: "cleared" | "busted" | "ran_out_of_data";
  dayIndex: number;
}

function runEvalTrial(shuffled: Trade[][]): EvalResult {
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let combineDays = 0;
  const combineDailyPnL: number[] = [];
  let dayIndex = 0;

  for (const dayTrades of shuffled) {
    dayIndex++;
    let dayPnl = 0;
    for (const tr of dayTrades) {
      const riskPoints = Math.abs(tr.entry - tr.stop);
      const pnl = tr.rMultiple * riskPoints * POINT_VALUE * CONTRACTS;
      balance += pnl;
      dayPnl += pnl;
      peak = Math.max(peak, balance);
      if (balance < floor) return { status: "busted", dayIndex };
    }
    if (!locked) {
      if (balance > ACCOUNT_SIZE + DD_AMOUNT + 100) {
        locked = true;
        floor = ACCOUNT_SIZE + 100;
      } else {
        floor = Math.max(floor, balance - DD_AMOUNT);
      }
    }

    combineDays++;
    combineDailyPnL.push(dayPnl);
    const totalProfit = balance - ACCOUNT_SIZE;
    const bestDay = Math.max(...combineDailyPnL);
    const consistencyOk = totalProfit <= 0 || bestDay <= EVAL_CONSISTENCY_PCT * totalProfit;
    if (totalProfit >= COMBINE_TARGET && combineDays >= 1 && consistencyOk) {
      return { status: "cleared", dayIndex };
    }
  }
  return { status: "ran_out_of_data", dayIndex };
}

function main() {
  console.log("=".repeat(100));
  console.log("Can rejection block (1h NQ) clear the LucidFlex 150K EVAL on its own?");
  console.log("=".repeat(100));
  console.log(`Underlying strategy: ${rbTrades.length} trades, ${(rbStats.winRate * 100).toFixed(1)}% win rate, ${dayBuckets.length} distinct NY trading days available`);
  console.log(`Rules: profit target $${COMBINE_TARGET.toLocaleString()}, Max Loss Limit $${DD_AMOUNT.toLocaleString()} (EOD trailing, locks at safety net), 50% consistency`);
  console.log(`Sizing: ${CONTRACTS} MNQ contracts (avg stop ${avgRiskPoints.toFixed(1)} pts -> ${((avgRiskPoints * POINT_VALUE * CONTRACTS / DD_AMOUNT) * 100).toFixed(1)}% of DD budget per trade)\n`);

  const results: EvalResult[] = [];
  for (let i = 0; i < TRIALS; i++) results.push(runEvalTrial(shuffle(dayBuckets)));

  const cleared = results.filter((r) => r.status === "cleared");
  const busted = results.filter((r) => r.status === "busted");
  const ranOut = results.filter((r) => r.status === "ran_out_of_data");
  const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;

  console.log(`Cleared the eval: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   (avg ${avgDaysToClear.toFixed(1)} trading days to clear)`);
  console.log(`Busted (hit the MLL): ${((busted.length / TRIALS) * 100).toFixed(1)}%`);
  console.log(`Ran out of the ${dayBuckets.length}-day data pool without clearing or busting: ${((ranOut.length / TRIALS) * 100).toFixed(1)}%`);

  writeFileSync(
    "data/rejectionblock-lucidflex-eval-check-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        trials: TRIALS,
        distinctDays: dayBuckets.length,
        clearRate: (cleared.length / TRIALS) * 100,
        bustRate: (busted.length / TRIALS) * 100,
        ranOutRate: (ranOut.length / TRIALS) * 100,
        avgDaysToClear,
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/rejectionblock-lucidflex-eval-check-results.json");
}

main();
