import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const DEADLINE = { deadlineHour: 16, deadlineMinute: 45 }; // LucidFlex, representative
const VOL_MULT = 1.5; // the validated multiplier from the sensitivity sweep
const VOL_LOOKBACK = 20; // the validated lookback

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
function summarize(result: StrategyResult): string {
  const s = result.stats;
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%`;
}
function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}
function baseSignals(bars: Bar[]): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  return dayHourFilter(bars, merge(meanRev, trend));
}
function avgVolume(bars: Bar[], lookback: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.v;
    if (i >= lookback) sum -= bars[i - lookback]!.v;
    if (i >= lookback - 1) out[i] = sum / lookback;
  }
  return out;
}
function isVolumeSpike(bars: Bar[], avgVol: number[], barIndex: number): boolean {
  const avg = avgVol[barIndex]!;
  if (isNaN(avg) || avg === 0) return false;
  return bars[barIndex]!.v / avg >= VOL_MULT;
}

// Concept A -- EXHAUSTION: a volume spike on the reversal candle is only "exhaustion" if it
// caps off a real prior run in the direction being reversed. For a short (reversing a rally),
// require a clear net UP move over the preceding runLookback bars; for a long (reversing a
// selloff), a clear net DOWN move. This distinguishes "climax after a real move" from a random
// high-volume bar with no run behind it.
function isExhaustion(bars: Bar[], avgVol: number[], barIndex: number, direction: "long" | "short", runLookback: number, minRunPoints: number): boolean {
  if (!isVolumeSpike(bars, avgVol, barIndex)) return false;
  if (barIndex - runLookback < 0) return false;
  const runStart = bars[barIndex - runLookback]!.c;
  const runEnd = bars[barIndex - 1]!.c;
  const move = runEnd - runStart;
  // Short = reversing a rally (need a real prior up-move); long = reversing a selloff (real prior down-move).
  return direction === "short" ? move >= minRunPoints : move <= -minRunPoints;
}

// Concept B -- RESPECTED LEVEL: mark every past volume-spike bar's price as a "big print" level
// (where a large buyer/seller transacted). A new signal gets confluence if its swept level (the
// wick that triggered entry) sits close to one of those earlier marked levels -- price returning
// to, and reacting at, a level where a big buyer/seller was already active.
function buildBigPrintLevels(bars: Bar[], avgVol: number[]): number[] {
  const levels: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (isVolumeSpike(bars, avgVol, i)) levels.push((bars[i]!.h + bars[i]!.l + bars[i]!.c) / 3);
  }
  return levels;
}
function isNearBigPrintLevel(price: number, levels: { price: number; barIndex: number }[], asOfBarIndex: number, tolerancePct: number): boolean {
  return levels.some((l) => l.barIndex < asOfBarIndex && Math.abs(l.price - price) / price <= tolerancePct);
}

type ConfigName = "baseline" | "spikeOnly" | "exhaustion" | "respectedLevel" | "exhaustionOrRespected" | "exhaustionAndRespected";

function build(bars: Bar[], config: ConfigName): StrategyResult {
  const avgVol = avgVolume(bars, VOL_LOOKBACK);

  // Build the level list WITH bar indices for the "prior only" check.
  const levelPoints: { price: number; barIndex: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (isVolumeSpike(bars, avgVol, i)) levelPoints.push({ price: (bars[i]!.h + bars[i]!.l + bars[i]!.c) / 3, barIndex: i });
  }

  let signals = baseSignals(bars);
  if (config !== "baseline") {
    signals = signals.filter((s) => {
      const exhaustion = isExhaustion(bars, avgVol, s.barIndex, s.direction, 12, 15); // ~1hr run, 15pt min move on NQ
      const respected = isNearBigPrintLevel(s.stop, levelPoints, s.barIndex, 0.0015);
      const spike = isVolumeSpike(bars, avgVol, s.barIndex);
      if (config === "spikeOnly") return spike;
      if (config === "exhaustion") return exhaustion;
      if (config === "respectedLevel") return respected;
      if (config === "exhaustionOrRespected") return exhaustion || respected;
      if (config === "exhaustionAndRespected") return exhaustion && respected;
      return true;
    });
  }
  signals = overrideTargetR(signals, 5);
  const trades = simulateTradesWithSessionDeadline(bars, signals, DEADLINE);
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: config, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const configs: ConfigName[] = ["baseline", "spikeOnly", "exhaustion", "respectedLevel", "exhaustionOrRespected", "exhaustionAndRespected"];
  const labels: Record<ConfigName, string> = {
    baseline: "Baseline (no volume filter)",
    spikeOnly: "Plain volume spike (1.5x/20bar, for reference -- already validated)",
    exhaustion: "EXHAUSTION: volume spike capping a real prior run (12bar/15pt)",
    respectedLevel: "RESPECTED LEVEL: entry reacts at a prior big-print level",
    exhaustionOrRespected: "Exhaustion OR respected level (either qualifies)",
    exhaustionAndRespected: "Exhaustion AND respected level (both required)",
  };

  console.log("=".repeat(120));
  console.log("Exhaustion reversal + respected big-buyer/seller levels -- flagship strategy");
  console.log("=".repeat(120));

  const fullResults: Record<string, StrategyResult> = {};
  for (const c of configs) {
    const r = build(nq5m, c);
    fullResults[c] = r;
    console.log(`${labels[c].padEnd(62)} ${summarize(r)}`);
  }
  output.fullPeriod = Object.fromEntries(configs.map((c) => [c, fullResults[c]!.stats]));

  console.log("\n" + "=".repeat(120));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(120));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const c of configs) {
    const h1 = build(nq5m.slice(0, mid), c);
    const h2 = build(nq5m.slice(mid), c);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${labels[c].padEnd(62)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
    splitResults.push({ config: c, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(120));
  console.log("CHECK 2: Transaction cost sensitivity (conservative scenario)");
  console.log("=".repeat(120));
  const costResults: unknown[] = [];
  for (const c of configs) {
    const full = fullResults[c]!;
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${labels[c].padEnd(62)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ config: c, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(120));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES and RTY");
  console.log("=".repeat(120));
  const oosResults: unknown[] = [];
  for (const c of configs) {
    const oosEs = build(es5m, c);
    const oosRty = build(rty5m, c);
    console.log(`${labels[c]}`);
    console.log(`  ES:  ${summarize(oosEs)}`);
    console.log(`  RTY: ${summarize(oosRty)}`);
    oosResults.push({ config: c, es: oosEs.stats, rty: oosRty.stats });
  }
  output.outOfSample = oosResults;

  writeFileSync("data/flagship-exhaustion-and-respected-levels-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-exhaustion-and-respected-levels-test-results.json");
}

main();
