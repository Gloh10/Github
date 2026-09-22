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
    if (totalProfit >= COMBINE_TARGET && combineDays >= 1 && consistencyOk) return { status: "cleared", dayIndex };
  }
  return { status: "ran_out_of_data", dayIndex };
}

function buildTrades(bars: Bar[], excludedHours: number[]): Trade[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const merged = merge(meanRev, trend);
  const filtered = merged.filter((s) => {
    const bar = bars[s.barIndex]!;
    const hour = nyHour(bar.t);
    const weekday = nyWeekday(bar.t);
    if (excludedHours.includes(hour)) return false;
    if (weekday === 0) return false; // Sunday always excluded (near-zero-volume open, kept in every variant)
    if (weekday === 1 && [1, 2, 3].includes(hour)) return false; // Monday 1-3am NY always excluded
    return true;
  });
  const signals = overrideTargetR(filtered, 5);
  return runStrategy("best", bars, signals).trades;
}

function evaluate(label: string, bars: Bar[], excludedHours: number[]) {
  const trades = buildTrades(bars, excludedHours);
  const wins = trades.filter((t) => t.outcome === "win").length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgR = trades.length > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;

  const dayBucketsMap = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(bars[t.barIndex]!.t);
    if (!dayBucketsMap.has(key)) dayBucketsMap.set(key, []);
    dayBucketsMap.get(key)!.push(t);
  }
  const dayBuckets = [...dayBucketsMap.values()];

  const results: EvalResult[] = [];
  for (let i = 0; i < TRIALS; i++) results.push(runEvalTrial(shuffle(dayBuckets)));
  const cleared = results.filter((r) => r.status === "cleared");
  const busted = results.filter((r) => r.status === "busted");
  const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;

  console.log(`${label.padEnd(38)} trades=${String(trades.length).padStart(3)}  days=${String(dayBuckets.length).padStart(2)}  winRate=${(winRate * 100).toFixed(1).padStart(5)}%  avgR=${avgR.toFixed(2).padStart(5)}  clearRate=${((cleared.length / TRIALS) * 100).toFixed(1).padStart(5)}%  bustRate=${((busted.length / TRIALS) * 100).toFixed(1).padStart(5)}%  avgDaysToClear=${avgDaysToClear.toFixed(1)}`);

  return { label, trades: trades.length, distinctDays: dayBuckets.length, winRate: winRate * 100, avgR, clearRate: (cleared.length / TRIALS) * 100, bustRate: (busted.length / TRIALS) * 100, avgDaysToClear };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const FULL_EXCLUDED = [4, 8, 10, 12, 13, 18, 19, 23];

  console.log("=".repeat(130));
  console.log("Does loosening the hour filter (more trades/week) shorten LucidFlex 150K eval time? (1 NQ contract, same as baseline)");
  console.log("=".repeat(130));

  const summary = [
    evaluate("Baseline (all 8 hours excluded)", nq5m, FULL_EXCLUDED),
    evaluate("Remove 1 hour (hour 13 only)", nq5m, FULL_EXCLUDED.filter((h) => h !== 13)),
    evaluate("Remove 2 hours (13, 19)", nq5m, FULL_EXCLUDED.filter((h) => h !== 13 && h !== 19)),
    evaluate("Remove 4 hours (13,19,8,12)", nq5m, FULL_EXCLUDED.filter((h) => ![13, 19, 8, 12].includes(h))),
    evaluate("No hour filter at all", nq5m, []),
  ];

  writeFileSync("data/flagship-loosened-filter-eval-check-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, summary }, null, 2));
  console.log("\nFull results written to data/flagship-loosened-filter-eval-check-results.json");
}

main();
