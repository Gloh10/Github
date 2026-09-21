import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { choppinessIndex, sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}

const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];

/** Original hour filter plus: drop all Sunday entries, and Monday 1am-3am NY entries. */
function dayHourFilter(bars: Bar[], signals: Signal[]): Signal[] {
  return signals.filter((s) => {
    const bar = bars[s.barIndex]!;
    const hour = nyHour(bar.t);
    const weekday = nyWeekday(bar.t);
    if (EXCLUDED_HOURS.includes(hour)) return false;
    if (weekday === 0) return false; // Sunday
    if (weekday === 1 && EXCLUDED_MONDAY_HOURS.includes(hour)) return false; // Monday 1-3am
    return true;
  });
}

/** Applies rNormal to every signal, except those falling in a "choppy" bar (chop[barIndex] >= threshold), which get rChoppy. */
function overrideTargetRByChop(
  signals: Signal[],
  chop: number[],
  threshold: number,
  rNormal: number,
  rChoppy: number,
): Signal[] {
  return signals.map((s) => {
    const c = chop[s.barIndex]!;
    const r = !Number.isNaN(c) && c >= threshold ? rChoppy : rNormal;
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * r : s.entry - risk * r;
    return { ...s, target };
  });
}

const PARAMS = { flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 12 };
const CHOP_LOOKBACK = 14;

function baseSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: PARAMS.flatSlopePct, slopeLookback: PARAMS.slopeLookback });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: PARAMS.trendSlopePct, slopeLookback: PARAMS.slopeLookback });
  return dayHourFilter(bars, merge(meanRev, trend));
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(50)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  // ============================================================
  // PART A: Sunday + Monday 1-3am exclusion added to the hour filter
  // ============================================================
  console.log("=".repeat(78));
  console.log("PART A: Day/hour filter (original hour filter + Sunday + Monday 1-3am excluded)");
  console.log("=".repeat(78));
  const prevBest = runStrategy(
    "Previous best (hour filter only, R=5)",
    nq5m,
    (() => {
      const vwap = sessionVwap(nq5m);
      const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: PARAMS.flatSlopePct, slopeLookback: PARAMS.slopeLookback });
      const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: PARAMS.trendSlopePct, slopeLookback: PARAMS.slopeLookback });
      return merge(meanRev, trend).filter((s) => !EXCLUDED_HOURS.includes(nyHour(nq5m[s.barIndex]!.t)));
    })().map((s) => {
      const risk = Math.abs(s.entry - s.stop);
      const target = s.direction === "long" ? s.entry + risk * 5 : s.entry - risk * 5;
      return { ...s, target };
    }),
  );
  summarize(prevBest);

  const newFiltered = runStrategy(
    "+ Sunday/Monday-early exclusion, R=5",
    nq5m,
    baseSignals(nq5m).map((s) => {
      const risk = Math.abs(s.entry - s.stop);
      const target = s.direction === "long" ? s.entry + risk * 5 : s.entry - risk * 5;
      return { ...s, target };
    }),
  );
  summarize(newFiltered);
  output.partA = { prevBest: prevBest.stats, newFiltered: newFiltered.stats };

  console.log("\n-- Split-period + ES OOS for the new day/hour filter (R=5, no chop adjustment yet) --");
  const mid = Math.floor(nq5m.length / 2);
  const firstHalf = nq5m.slice(0, mid);
  const secondHalf = nq5m.slice(mid);
  function runR5(bars: Bar[], name: string): StrategyResult {
    const sig = baseSignals(bars).map((s) => {
      const risk = Math.abs(s.entry - s.stop);
      const target = s.direction === "long" ? s.entry + risk * 5 : s.entry - risk * 5;
      return { ...s, target };
    });
    return runStrategy(name, bars, sig);
  }
  const h1 = runR5(firstHalf, "First half");
  const h2 = runR5(secondHalf, "Second half");
  const oosA = runR5(es5m, "ES 5-min (OOS)");
  [h1, h2, oosA].forEach(summarize);
  const bothPositiveA = h1.stats.totalR > 0 && h2.stats.totalR > 0;
  console.log(bothPositiveA ? "Verdict: POSITIVE in both halves." : "Verdict: NOT positive in both halves.");
  output.partAValidation = { firstHalf: h1.stats, secondHalf: h2.stats, oos: oosA.stats, bothPositive: bothPositiveA };

  // ============================================================
  // PART B: Choppiness-based R adjustment
  // ============================================================
  console.log("\n" + "=".repeat(78));
  console.log("PART B: Choppiness Index (14-bar) -- lower R during choppy conditions, R=5 otherwise");
  console.log("=".repeat(78));
  const chop = choppinessIndex(nq5m, CHOP_LOOKBACK);
  const chopValues = chop.filter((c) => !Number.isNaN(c));
  console.log(
    `CHOP stats over the dataset: min=${Math.min(...chopValues).toFixed(1)} max=${Math.max(...chopValues).toFixed(1)} ` +
      `median=${chopValues.sort((a, b) => a - b)[Math.floor(chopValues.length / 2)]!.toFixed(1)}`,
  );

  const thresholds = [55, 60, 61.8, 65, 70];
  const rChoppyValues = [1.5, 2, 2.5, 3];
  const grid: { threshold: number; rChoppy: number; result: StrategyResult }[] = [];
  console.log("\nGrid: final equity from $100 (rows=CHOP threshold, cols=rChoppy)");
  const header = "threshold\\rChoppy".padEnd(20) + rChoppyValues.map((r) => `R=${r}`.padStart(10)).join("");
  console.log(header);
  for (const threshold of thresholds) {
    const row: string[] = [];
    for (const rChoppy of rChoppyValues) {
      const signals = overrideTargetRByChop(baseSignals(nq5m), chop, threshold, 5, rChoppy);
      const result = runStrategy(`chop>=${threshold}->R${rChoppy}`, nq5m, signals);
      grid.push({ threshold, rChoppy, result });
      row.push(`$${result.stats.finalEquity.toFixed(2)}`.padStart(10));
    }
    console.log(String(threshold).padEnd(20) + row.join(""));
  }
  output.partBGrid = grid.map((c) => ({ threshold: c.threshold, rChoppy: c.rChoppy, stats: c.result.stats }));

  const rankedB = [...grid].sort((a, b) => b.result.stats.finalEquity - a.result.stats.finalEquity);
  console.log("\n=== Top 5 chop-adjusted configs ===");
  rankedB.slice(0, 5).forEach((c, i) => {
    console.log(`${i + 1}. threshold=${c.threshold}, rChoppy=${c.rChoppy} —`);
    summarize(c.result);
  });

  const bestB = rankedB[0]!;
  console.log(`\n-- Validating best chop config (threshold=${bestB.threshold}, rChoppy=${bestB.rChoppy}) --`);
  function runChopVariant(bars: Bar[], name: string): StrategyResult {
    const chopBars = choppinessIndex(bars, CHOP_LOOKBACK);
    const sig = overrideTargetRByChop(baseSignals(bars), chopBars, bestB.threshold, 5, bestB.rChoppy);
    return runStrategy(name, bars, sig);
  }
  const fullB = runChopVariant(nq5m, "Full");
  const h1B = runChopVariant(firstHalf, "First half");
  const h2B = runChopVariant(secondHalf, "Second half");
  const oosB = runChopVariant(es5m, "ES 5-min (OOS)");
  [fullB, h1B, h2B, oosB].forEach(summarize);
  const bothPositiveB = h1B.stats.totalR > 0 && h2B.stats.totalR > 0;
  console.log(bothPositiveB ? "Verdict: POSITIVE in both halves." : "Verdict: NOT positive in both halves.");
  output.partBBest = { threshold: bestB.threshold, rChoppy: bestB.rChoppy };
  output.partBValidation = { full: fullB.stats, firstHalf: h1B.stats, secondHalf: h2B.stats, oos: oosB.stats, bothPositive: bothPositiveB };

  writeFileSync("data/refine-c1-5m-v2-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/refine-c1-5m-v2-results.json");
}

main();
