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

const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500;
const EVAL_CONSISTENCY_PCT = 0.5;
const POINT_VALUE = NQ_POINT_VALUE_USD;
const MAX_SIZE_NQ = 10; // LucidFlex 150K published max size: 10 mini OR 100 micro

interface EvalResult {
  status: "cleared" | "busted" | "ran_out_of_data";
  dayIndex: number;
}

function runEvalTrial(shuffled: Trade[][], contracts: number): EvalResult {
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
      const pnl = tr.rMultiple * riskPoints * POINT_VALUE * contracts;
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
  console.log("Does sizing UP during the eval shorten the time-to-clear? (LucidFlex 150K, flagship strategy)");
  console.log("=".repeat(100));
  console.log(`Underlying: ${trades.length} trades, ${dayBuckets.length} distinct NY trading days, avg stop ${avgRiskPoints.toFixed(1)} pts`);
  console.log(`LucidFlex 150K published max size: ${MAX_SIZE_NQ} mini contracts. Current baseline used 1 contract (9.5% of DD budget/trade).\n`);

  const shuffledTrials: Trade[][][] = [];
  for (let i = 0; i < TRIALS; i++) shuffledTrials.push(shuffle(dayBuckets));

  console.log("Contracts  DD%/trade   ClearRate   BustRate   RanOut   AvgDaysToClear");
  console.log("-".repeat(100));

  const summary: Record<string, unknown>[] = [];
  for (let contracts = 1; contracts <= MAX_SIZE_NQ; contracts++) {
    const ddPctPerTrade = (avgRiskPoints * POINT_VALUE * contracts) / DD_AMOUNT;
    const results = shuffledTrials.map((s) => runEvalTrial(s, contracts));
    const cleared = results.filter((r) => r.status === "cleared");
    const busted = results.filter((r) => r.status === "busted");
    const ranOut = results.filter((r) => r.status === "ran_out_of_data");
    const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;

    console.log(
      `${String(contracts).padStart(9)}  ${(ddPctPerTrade * 100).toFixed(1).padStart(8)}%   ` +
        `${((cleared.length / TRIALS) * 100).toFixed(1).padStart(8)}%   ${((busted.length / TRIALS) * 100).toFixed(1).padStart(7)}%   ` +
        `${((ranOut.length / TRIALS) * 100).toFixed(1).padStart(5)}%   ${avgDaysToClear.toFixed(1).padStart(6)}`,
    );

    summary.push({
      contracts,
      ddPctPerTrade: ddPctPerTrade * 100,
      clearRate: (cleared.length / TRIALS) * 100,
      bustRate: (busted.length / TRIALS) * 100,
      ranOutRate: (ranOut.length / TRIALS) * 100,
      avgDaysToClear,
    });
  }

  writeFileSync("data/flagship-lucidflex-eval-sizing-sweep-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, distinctDays: dayBuckets.length, summary }, null, 2));
  console.log("\nFull results written to data/flagship-lucidflex-eval-sizing-sweep-results.json");
}

main();
