import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { emaPullback, pocMeanReversion, valueAreaBreakout, valueAreaFade, vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import { rollingValueArea } from "../src/backtest/volumeProfile.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const TRIALS = 2000;
const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}
function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}
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

const nq5m = loadBars("data/nq-5m.json");

function buildTrades(label: string): Trade[] {
  const va = rollingValueArea(nq5m, 40);
  let signals: Signal[];
  switch (label) {
    case "flagship": {
      const vwap = sessionVwap(nq5m);
      const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
      const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
      signals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
      break;
    }
    case "valueAreaFade":
      signals = dayHourFilter(nq5m, valueAreaFade(nq5m, va, { targetMode: "poc" }));
      break;
    case "pocMeanReversion":
      signals = dayHourFilter(nq5m, pocMeanReversion(nq5m, va));
      break;
    case "valueAreaBreakout":
      signals = dayHourFilter(nq5m, valueAreaBreakout(nq5m, va, { targetR: 5 }));
      break;
    case "emaPullback":
      signals = dayHourFilter(nq5m, emaPullback(nq5m, 21, 50, { targetR: 5, touchTolerancePct: 0.0015 }));
      break;
    default:
      throw new Error("unknown");
  }
  return simulateTradesWithSessionDeadline(nq5m, signals, { deadlineHour: 16, deadlineMinute: 45 }); // LucidFlex deadline
}

function buildDayBuckets(trades: Trade[]): Trade[][] {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(nq5m[t.barIndex]!.t);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.values()];
}

// LucidFlex 150K eval rules (verified from the user's screenshots): $9,000 target,
// $4,500 MLL (EOD trailing, locks at safety net), 50% consistency.
const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500;
const EVAL_CONSISTENCY_PCT = 0.5;

interface EvalResult {
  status: "cleared" | "busted" | "ran_out_of_data";
  dayIndex: number;
}

const CONSERVATIVE_COST_USD = 10 + 2 * NQ_POINT_VALUE_USD; // matches the "conservative" scenario used throughout this session
function applyCost(trades: Trade[]): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? CONSERVATIVE_COST_USD / (riskPoints * NQ_POINT_VALUE_USD) : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
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
      const pnl = tr.rMultiple * riskPoints * NQ_POINT_VALUE_USD * contracts;
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

function main() {
  console.log("=".repeat(100));
  console.log("Can any of the 4 new strategies actually clear a LucidFlex 150K eval? (1 NQ contract, 2000 trials each)");
  console.log("=".repeat(100));

  const labels = ["flagship", "valueAreaFade", "pocMeanReversion", "valueAreaBreakout", "emaPullback"];
  const summary: Record<string, unknown>[] = [];

  for (const label of labels) {
    const rawTrades = buildTrades(label);
    const avgRiskPoints = rawTrades.length > 0 ? rawTrades.reduce((s, t) => s + Math.abs(t.entry - t.stop), 0) / rawTrades.length : 0;

    for (const [costLabel, trades] of [
      ["no cost", rawTrades],
      ["w/ conservative cost", applyCost(rawTrades)],
    ] as const) {
      const dayBuckets = buildDayBuckets(trades);
      const results: EvalResult[] = [];
      for (let i = 0; i < TRIALS; i++) results.push(runEvalTrial(shuffle(dayBuckets), 1));

      const cleared = results.filter((r) => r.status === "cleared");
      const busted = results.filter((r) => r.status === "busted");
      const ranOut = results.filter((r) => r.status === "ran_out_of_data");
      const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;

      console.log(
        `${label.padEnd(20)} (${costLabel.padEnd(21)}) trades=${String(trades.length).padStart(4)}  days=${String(dayBuckets.length).padStart(2)}  avgRisk=${avgRiskPoints.toFixed(1).padStart(6)}pts   ` +
          `clearRate=${((cleared.length / TRIALS) * 100).toFixed(1).padStart(5)}%  bustRate=${((busted.length / TRIALS) * 100).toFixed(1).padStart(5)}%  ranOut=${((ranOut.length / TRIALS) * 100).toFixed(1).padStart(5)}%  avgDaysToClear=${avgDaysToClear.toFixed(1)}`,
      );

      summary.push({
        strategy: label,
        costLabel,
        trades: trades.length,
        distinctDays: dayBuckets.length,
        clearRate: (cleared.length / TRIALS) * 100,
        bustRate: (busted.length / TRIALS) * 100,
        ranOutRate: (ranOut.length / TRIALS) * 100,
        avgDaysToClear,
      });
    }
  }

  writeFileSync("data/new-strategies-eval-clearing-check-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), trials: TRIALS, summary }, null, 2));
  console.log("\nFull results written to data/new-strategies-eval-clearing-check-results.json");
}

main();
