import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

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
// The hour/weekday filter was tuned specifically on 5-min NQ data. Applying it unchanged to
// other timeframes tests whether that SAME filter still helps there, not a re-optimized one.
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
function summarize(result: StrategyResult): string {
  const s = result.stats;
  return `trades=${String(s.totalTrades).padStart(4)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%`;
}

interface TfConfig {
  label: string;
  path: string;
  oosPath: string | null;
  flatSlopePct: number;
  trendSlopePct: number;
  slopeLookback: number; // scaled to represent a comparable wall-clock window per timeframe
}

const TIMEFRAMES: TfConfig[] = [
  { label: "5-min", path: "data/nq-5m.json", oosPath: "data/es-5m.json", flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 12 }, // ~60min
  { label: "15-min", path: "data/nq-15m.json", oosPath: null, flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 8 }, // ~2h
  { label: "1-hour", path: "data/nq-1h.json", oosPath: "data/es-1h.json", flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 6 }, // ~6h
];

function build(bars: Bar[], tf: TfConfig, useFilter: boolean): StrategyResult {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: tf.flatSlopePct, slopeLookback: tf.slopeLookback });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: tf.trendSlopePct, slopeLookback: tf.slopeLookback });
  let signals = merge(meanRev, trend);
  if (useFilter) signals = dayHourFilter(bars, signals);
  signals = overrideTargetR(signals, 5);
  return runStrategy(`${tf.label}${useFilter ? " +filter" : ""}`, bars, signals);
}

function main() {
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  console.log("=".repeat(110));
  console.log("Is 5-min really the best timeframe for this exact strategy? Same recipe (VWAP mean-rev + trend, R=5), swept across timeframes");
  console.log("=".repeat(110));
  console.log("slopeLookback scaled per timeframe to represent a comparable wall-clock analysis window (~1h/2h/6h).\n");

  const fullResults: Record<string, { noFilter: StrategyResult; withFilter: StrategyResult }> = {};
  for (const tf of TIMEFRAMES) {
    const bars = loadBars(tf.path);
    const noFilter = build(bars, tf, false);
    const withFilter = build(bars, tf, true);
    fullResults[tf.label] = { noFilter, withFilter };
    console.log(`${tf.label.padEnd(10)} (${bars.length} bars)  no filter:   ${summarize(noFilter)}`);
    console.log(`${"".padEnd(10)}              +5m-tuned filter: ${summarize(withFilter)}`);
  }
  output.fullPeriod = Object.fromEntries(TIMEFRAMES.map((tf) => [tf.label, { noFilter: fullResults[tf.label]!.noFilter.stats, withFilter: fullResults[tf.label]!.withFilter.stats }]));

  console.log("\n" + "=".repeat(110));
  console.log("CHECK 1: Split-period robustness (with the 5m-tuned filter applied, each timeframe's own data)");
  console.log("=".repeat(110));
  const splitResults: unknown[] = [];
  for (const tf of TIMEFRAMES) {
    const bars = loadBars(tf.path);
    const mid = Math.floor(bars.length / 2);
    const h1 = build(bars.slice(0, mid), tf, true);
    const h2 = build(bars.slice(mid), tf, true);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${tf.label.padEnd(10)} H1: ${summarize(h1)}`);
    console.log(`${"".padEnd(10)} H2: ${summarize(h2)}   ${bothPositive ? "POSITIVE both halves" : "NOT positive both halves"}`);
    splitResults.push({ timeframe: tf.label, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(110));
  console.log("CHECK 2: Out-of-sample -- identical rules run fresh on ES, same timeframe (where data exists)");
  console.log("=".repeat(110));
  const oosResults: unknown[] = [];
  for (const tf of TIMEFRAMES) {
    if (!tf.oosPath) {
      console.log(`${tf.label.padEnd(10)} no ES data at this timeframe -- skipped`);
      continue;
    }
    const oosBars = loadBars(tf.oosPath);
    const oosNoFilter = build(oosBars, tf, false);
    const oosWithFilter = build(oosBars, tf, true);
    console.log(`${tf.label.padEnd(10)} no filter:        ${summarize(oosNoFilter)}`);
    console.log(`${"".padEnd(10)} +5m-tuned filter: ${summarize(oosWithFilter)}`);
    oosResults.push({ timeframe: tf.label, noFilter: oosNoFilter.stats, withFilter: oosWithFilter.stats });
  }
  output.outOfSample = oosResults;

  console.log("\n" + "=".repeat(110));
  console.log("RANKED (with filter applied, full period, by avgR -- the fairest cross-timeframe comparator since trade COUNT differs a lot by timeframe)");
  console.log("=".repeat(110));
  [...TIMEFRAMES]
    .sort((a, b) => fullResults[b.label]!.withFilter.stats.avgR - fullResults[a.label]!.withFilter.stats.avgR)
    .forEach((tf, i) => {
      const s = fullResults[tf.label]!.withFilter.stats;
      console.log(`${i + 1}. ${tf.label.padEnd(10)} avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  trades=${s.totalTrades}  winRate=${(s.winRate * 100).toFixed(1)}%  maxDD=${s.maxDrawdownPct.toFixed(1)}%`);
    });

  writeFileSync("data/flagship-timeframe-comparison-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-timeframe-comparison-results.json");
}

main();
