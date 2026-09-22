import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy, simulateTradesWithPointsTrail } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { rejectionBlock, vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
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
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// -- Flagship: 5-min NQ, 1 full NQ contract.
const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const flagshipSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
const flagshipTrades = runStrategy("flagship", nq5m, flagshipSignals).trades;
const flagshipDayMap = new Map<string, Trade[]>();
for (const t of flagshipTrades) {
  const key = nyDateKey(nq5m[t.barIndex]!.t);
  if (!flagshipDayMap.has(key)) flagshipDayMap.set(key, []);
  flagshipDayMap.get(key)!.push(t);
}
const flagshipDayBuckets = [...flagshipDayMap.values()].map((dayTrades) => dayTrades.map((t) => ({ trade: t, contracts: 1, pointValue: NQ_POINT_VALUE_USD })));

// -- Rejection block: 1h NQ, 4 MNQ contracts (sizing already established for this DD budget).
const nq1h = loadBars("data/nq-1h.json");
const rbSignals = rejectionBlock(nq1h, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
const rbTrades = simulateTradesWithPointsTrail(nq1h, rbSignals, { breakevenTriggerPoints: 0, trailStartPoints: 5, trailDistancePoints: 2 });
computeStats(rbTrades, buildEquityCurve(nq1h, rbTrades)); // sanity-computed, not otherwise used here
const rbDayMap = new Map<string, Trade[]>();
for (const t of rbTrades) {
  const key = nyDateKey(nq1h[t.barIndex]!.t);
  if (!rbDayMap.has(key)) rbDayMap.set(key, []);
  rbDayMap.get(key)!.push(t);
}
const rbDayBuckets = [...rbDayMap.values()].map((dayTrades) => dayTrades.map((t) => ({ trade: t, contracts: 4, pointValue: MNQ_POINT_VALUE_USD })));

interface SizedTrade {
  trade: Trade;
  contracts: number;
  pointValue: number;
}

const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const DD_AMOUNT = 4_500;
const EVAL_CONSISTENCY_PCT = 0.5;

interface EvalResult {
  status: "cleared" | "busted" | "ran_out_of_data";
  dayIndex: number;
}

function runEvalTrial(dayPairs: SizedTrade[][]): EvalResult {
  let balance = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD_AMOUNT;
  let locked = false;
  let combineDays = 0;
  const combineDailyPnL: number[] = [];
  let dayIndex = 0;

  for (const dayTrades of dayPairs) {
    dayIndex++;
    let dayPnl = 0;
    for (const st of dayTrades) {
      const riskPoints = Math.abs(st.trade.entry - st.trade.stop);
      const pnl = st.trade.rMultiple * riskPoints * st.pointValue * st.contracts;
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

function runFlagshipOnly(): EvalResult {
  const shuffled = shuffle(flagshipDayBuckets);
  return runEvalTrial(shuffled);
}

function runCombined(): EvalResult {
  // Pairs a random flagship trading day with a random rejection-block trading day as one
  // "combined calendar day" -- an approximation, since the two datasets don't span the exact
  // same calendar range (flagship: last ~18 days; rejection block: ~10 months). This models
  // "what if both strategies ran on the same account going forward," treating each strategy's
  // historical days as independent draws rather than requiring literal date overlap.
  const flagshipShuffled = shuffle(flagshipDayBuckets);
  const rbShuffled = shuffle(rbDayBuckets).slice(0, flagshipShuffled.length);
  const combinedDays: SizedTrade[][] = flagshipShuffled.map((fDay, i) => [...fDay, ...(rbShuffled[i] ?? [])]);
  return runEvalTrial(combinedDays);
}

function main() {
  console.log("=".repeat(110));
  console.log("Does trading flagship + rejection block SIMULTANEOUSLY shorten the LucidFlex 150K eval?");
  console.log("=".repeat(110));
  console.log(`Flagship: ${flagshipTrades.length} trades / ${flagshipDayBuckets.length} days (5-min NQ, 1 NQ contract)`);
  console.log(`Rejection block: ${rbTrades.length} trades / ${rbDayBuckets.length} days (1h NQ, 4 MNQ contracts)`);
  console.log(`CAVEAT: combined trial pairs a random flagship day with a random rejection-block day as one "day" --`);
  console.log(`the two datasets don't share the same calendar range, so this approximates running both strategies`);
  console.log(`going forward rather than replaying one specific real history.\n`);

  const flagshipOnly: EvalResult[] = [];
  const combined: EvalResult[] = [];
  for (let i = 0; i < TRIALS; i++) {
    flagshipOnly.push(runFlagshipOnly());
    combined.push(runCombined());
  }

  for (const [label, results] of [
    ["Flagship ONLY", flagshipOnly],
    ["Flagship + Rejection Block COMBINED", combined],
  ] as const) {
    const cleared = results.filter((r) => r.status === "cleared");
    const busted = results.filter((r) => r.status === "busted");
    const avgDaysToClear = cleared.length > 0 ? cleared.reduce((s, r) => s + r.dayIndex, 0) / cleared.length : NaN;
    console.log(`${label.padEnd(38)} clearRate=${((cleared.length / TRIALS) * 100).toFixed(1).padStart(5)}%  bustRate=${((busted.length / TRIALS) * 100).toFixed(1).padStart(5)}%  avgDaysToClear=${avgDaysToClear.toFixed(1)}`);
  }

  const clearedF = flagshipOnly.filter((r) => r.status === "cleared");
  const clearedC = combined.filter((r) => r.status === "cleared");
  writeFileSync(
    "data/combined-strategies-eval-check-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        trials: TRIALS,
        flagshipOnly: {
          clearRate: (clearedF.length / TRIALS) * 100,
          bustRate: (flagshipOnly.filter((r) => r.status === "busted").length / TRIALS) * 100,
          avgDaysToClear: clearedF.reduce((s, r) => s + r.dayIndex, 0) / clearedF.length,
        },
        combined: {
          clearRate: (clearedC.length / TRIALS) * 100,
          bustRate: (combined.filter((r) => r.status === "busted").length / TRIALS) * 100,
          avgDaysToClear: clearedC.reduce((s, r) => s + r.dayIndex, 0) / clearedC.length,
        },
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/combined-strategies-eval-check-results.json");
}

main();
