import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, buyAndHoldCurve, computeStats, simulateTrades } from "../src/backtest/engine.js";
import { computePeriodBias, monthKeyFn, weekKeyFn } from "../src/backtest/htfIct.js";
import { buildMonthlyBiasWeeklyObSignals, buildWeeklyBiasDailyOteSignals } from "../src/backtest/htfStrategies.js";
import { resampleToMonthly, resampleToWeekly } from "../src/backtest/resample.js";
import type { Bar, Trade } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function avgHoldingDays(dailyBars: Bar[], trades: Trade[]): number {
  if (trades.length === 0) return NaN;
  const totalDays = trades.reduce((sum, t) => {
    const entryT = dailyBars[t.barIndex]!.t;
    const exitT = dailyBars[t.exitBarIndex]!.t;
    return sum + (exitT - entryT) / 86400;
  }, 0);
  return totalDays / trades.length;
}

function report(label: string, dailyBars: Bar[], trades: Trade[]) {
  const equityCurve = buildEquityCurve(dailyBars, trades);
  const stats = computeStats(trades, equityCurve);
  const avgDays = avgHoldingDays(dailyBars, trades);
  console.log("-".repeat(100));
  console.log(label);
  console.log("-".repeat(100));
  console.log(
    `Trades: ${stats.totalTrades}  Win rate: ${(stats.winRate * 100).toFixed(1)}%  Avg R: ${stats.avgR.toFixed(2)}  Total R: ${stats.totalR.toFixed(1)}  Max DD: ${stats.maxDrawdownPct.toFixed(1)}%  Final equity (100 start): ${stats.finalEquity.toFixed(1)}  Avg holding: ${avgDays.toFixed(0)} calendar days`,
  );
  const longs = trades.filter((t) => t.direction === "long");
  const shorts = trades.filter((t) => t.direction === "short");
  const longWins = longs.filter((t) => t.rMultiple > 0).length;
  const shortWins = shorts.filter((t) => t.rMultiple > 0).length;
  console.log(
    `  By direction -- long: n=${longs.length} winRate=${longs.length ? ((longWins / longs.length) * 100).toFixed(1) : "NA"}%  short: n=${shorts.length} winRate=${shorts.length ? ((shortWins / shorts.length) * 100).toFixed(1) : "NA"}%`,
  );
  return {
    stats,
    avgHoldingDays: avgDays,
    byDirection: {
      long: { n: longs.length, winRate: longs.length ? longWins / longs.length : null, totalR: longs.reduce((s, t) => s + t.rMultiple, 0) },
      short: { n: shorts.length, winRate: shorts.length ? shortWins / shorts.length : null, totalR: shorts.reduce((s, t) => s + t.rMultiple, 0) },
    },
  };
}

const spyDaily = loadBars("data/spy-1d.json");
const spyWeekly = resampleToWeekly(spyDaily);
const spyMonthly = resampleToMonthly(spyDaily);

console.log(`SPY: ${spyDaily.length} daily bars, ${spyWeekly.length} weekly bars, ${spyMonthly.length} monthly bars`);
console.log(`Range: ${new Date(spyDaily[0]!.t * 1000).toISOString().slice(0, 10)} to ${new Date(spyDaily[spyDaily.length - 1]!.t * 1000).toISOString().slice(0, 10)}\n`);

// Monthly bias computed off WEEKLY bars (prior month's H/L swept+reclaimed by a weekly close).
const monthlyBiasPerWeeklyBar = computePeriodBias(spyWeekly, monthKeyFn, 4);
// Weekly bias computed off DAILY bars (prior week's H/L swept+reclaimed by a daily close).
const weeklyBiasPerDailyBar = computePeriodBias(spyDaily, weekKeyFn, 5);

const biasCoverageMonthly = monthlyBiasPerWeeklyBar.filter((b) => b !== null).length;
const biasCoverageWeekly = weeklyBiasPerDailyBar.filter((b) => b !== null).length;
console.log(`Monthly bias set on ${biasCoverageMonthly}/${spyWeekly.length} weekly bars (${((biasCoverageMonthly / spyWeekly.length) * 100).toFixed(0)}%)`);
console.log(`Weekly bias set on ${biasCoverageWeekly}/${spyDaily.length} daily bars (${((biasCoverageWeekly / spyDaily.length) * 100).toFixed(0)}%)\n`);

// --- Strategy A: Monthly bias + Weekly Order Block entry (position trade) ---
const sigA = buildMonthlyBiasWeeklyObSignals(spyDaily, spyWeekly, monthlyBiasPerWeeklyBar, {
  weeklyPivotConfirm: 3,
  fallbackTargetR: 3,
});
const tradesA = simulateTrades(spyDaily, sigA);
const resultA = report("STRATEGY A: Monthly bias + Weekly Order Block entry (daily resolution)", spyDaily, tradesA);

// --- Strategy A, fixed-R target variant (no open-ended "nearest pivot" target) ---
// Isolates entry-quality edge from target-selection luck: the "nearest weekly
// pivot" target in Strategy A is occasionally very far away, producing a few
// huge-R outlier trades that can dominate total R without reflecting typical
// trade quality. This variant uses a plain fixed R-multiple target throughout.
console.log("Strategy A outlier check: top trades by R can dominate total R when the target is an open-ended\n'nearest liquidity pool' rather than fixed -- testing fixed-R variants to isolate genuine entry edge:\n");
for (const fixedR of [1.5, 2, 3]) {
  const sigFixed = buildMonthlyBiasWeeklyObSignals(spyDaily, spyWeekly, monthlyBiasPerWeeklyBar, {
    weeklyPivotConfirm: 3,
    fallbackTargetR: fixedR,
    disablePivotTarget: true,
  });
  const tradesFixed = simulateTrades(spyDaily, sigFixed);
  report(`STRATEGY A (fixed ${fixedR}R target only, no open-ended pivot target)`, spyDaily, tradesFixed);
}
console.log();

// --- Strategy A2: same, but requiring BPR confluence (Unicorn-style higher confidence filter) ---
const sigA2 = buildMonthlyBiasWeeklyObSignals(spyDaily, spyWeekly, monthlyBiasPerWeeklyBar, {
  weeklyPivotConfirm: 3,
  fallbackTargetR: 3,
  requireBprConfluence: true,
});
const tradesA2 = simulateTrades(spyDaily, sigA2);
const resultA2 = report("STRATEGY A2: Strategy A filtered to Order Block + BPR confluence (Unicorn-style)", spyDaily, tradesA2);

// --- Strategy B: Weekly bias + Daily OTE entry (swing trade) ---
const sigB = buildWeeklyBiasDailyOteSignals(spyDaily, weeklyBiasPerDailyBar, { dailyPivotConfirm: 3, targetR: 3 });
const tradesB = simulateTrades(spyDaily, sigB);
const resultB = report("STRATEGY B: Weekly bias + Daily OTE entry (daily resolution)", spyDaily, tradesB);

// --- Benchmark: buy and hold ---
const bhCurve = buyAndHoldCurve(spyDaily);
const bhFinal = bhCurve[bhCurve.length - 1]!.equity;
console.log("-".repeat(100));
console.log(`BENCHMARK: Buy-and-hold SPY over the same period -- final equity (100 start): ${bhFinal.toFixed(1)}`);
console.log("-".repeat(100));

const fixedRResults = [1.5, 2, 3].map((fixedR) => {
  const sigFixed = buildMonthlyBiasWeeklyObSignals(spyDaily, spyWeekly, monthlyBiasPerWeeklyBar, {
    weeklyPivotConfirm: 3,
    fallbackTargetR: fixedR,
    disablePivotTarget: true,
  });
  const tradesFixed = simulateTrades(spyDaily, sigFixed);
  const stats = computeStats(tradesFixed, buildEquityCurve(spyDaily, tradesFixed));
  return { fixedR, trades: tradesFixed.length, winRate: stats.winRate, avgR: stats.avgR, totalR: stats.totalR };
});

writeFileSync(
  "data/ict-htf-backtest-results.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      instrument: "SPY",
      caveat: "Single instrument (SPY) tested so far; cross-validation on QQQ and individual names deferred (TradingView daily quota exhausted). Strategy B's n=9 is too small to draw any conclusion. Strategy A/A2's open-ended 'nearest pivot' target concentrates ~66-70% of total R in the top 5 of ~30 trades -- see fixedRVariants for a cleaner, non-outlier-dependent read on entry quality. Long-side win rate is likely inflated by SPY's secular uptrend; the short-side results (which fight that trend) are the more meaningful test of the methodology's actual edge.",
      dataRange: { from: new Date(spyDaily[0]!.t * 1000).toISOString().slice(0, 10), to: new Date(spyDaily[spyDaily.length - 1]!.t * 1000).toISOString().slice(0, 10) },
      bars: { daily: spyDaily.length, weekly: spyWeekly.length, monthly: spyMonthly.length },
      strategyA: { ...resultA, trades: tradesA.length },
      strategyA_fixedRVariants: fixedRResults,
      strategyA2_bprConfluence: { ...resultA2, trades: tradesA2.length },
      strategyB: { ...resultB, trades: tradesB.length },
      buyAndHoldFinalEquity: bhFinal,
    },
    null,
    2,
  ),
);
console.log("\nFull results written to data/ict-htf-backtest-results.json");
