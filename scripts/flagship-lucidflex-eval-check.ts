import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
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

// LucidFlex 150K eval, sized as established: 1 full NQ contract, ~9.5% of the DD budget.
const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500;
const EVAL_CONSISTENCY_PCT = 0.5;
const CONTRACTS = 1;
const POINT_VALUE = NQ_POINT_VALUE_USD;

interface EvalResult {
  status: "cleared" | "busted" | "ran_out_of_data";
  dayIndex: number;
}

function runEvalTrial(shuffled: Trade[][]): EvalResult {
  let balance = ACCOUNT_SIZE;
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

  console.log("=".repeat(100));
  console.log("Can the FLAGSHIP strategy (5-min NQ, mean-rev + trend, R=5) clear the LucidFlex 150K EVAL on its own?");
  console.log("=".repeat(100));
  console.log(`Underlying strategy: ${trades.length} trades, ${dayBuckets.length} distinct NY trading days available`);
  console.log(`Rules: profit target $${COMBINE_TARGET.toLocaleString()}, Max Loss Limit $${DD_AMOUNT.toLocaleString()} (EOD trailing, locks at safety net), 50% consistency`);
  console.log(`Sizing: ${CONTRACTS} full NQ contract (avg stop ${avgRiskPoints.toFixed(1)} pts -> ${((avgRiskPoints * POINT_VALUE * CONTRACTS / DD_AMOUNT) * 100).toFixed(1)}% of DD budget per trade)\n`);

  const results: EvalResult[] = [];
  for (let i = 0; i < TRIALS; i++) results.push(runEvalTrial(shuffle(dayBuckets)));

  const cleared = results.filter((r) => r.status === "cleared");
  const busted = results.filter((r) => r.status === "busted");
  const ranOut = results.filter((r) => r.status === "ran_out_of_data");
  const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;

  console.log(`Cleared the eval: ${((cleared.length / TRIALS) * 100).toFixed(1)}%   (avg ${avgDaysToClear.toFixed(1)} of ${dayBuckets.length} available trading days to clear)`);
  console.log(`Busted (hit the MLL): ${((busted.length / TRIALS) * 100).toFixed(1)}%`);
  console.log(`Ran out of the ${dayBuckets.length}-day data pool without clearing or busting: ${((ranOut.length / TRIALS) * 100).toFixed(1)}%`);

  console.log("\n" + "=".repeat(100));
  console.log("FOR COMPARISON -- rejection block (1h NQ) on the same LucidFlex 150K eval:");
  console.log("=".repeat(100));
  console.log("  Cleared: 100.0%   Busted: 0.0%   Avg days to clear: 30.1 of 32 available");

  writeFileSync(
    "data/flagship-lucidflex-eval-check-results.json",
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
  console.log("\nFull results written to data/flagship-lucidflex-eval-check-results.json");
}

main();
