import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour } from "../src/backtest/nyTime.js";
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

/** Drops signals whose entry bar falls in one of the excluded NY hours. */
function hourFilter(bars: Bar[], signals: Signal[], excludedHours: number[]): Signal[] {
  return signals.filter((s) => !excludedHours.includes(nyHour(bars[s.barIndex]!.t)));
}

const PARAMS = { flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 12 };
const TARGET_R = 5;
// Diagnosed from the 72-trade full-period baseline: hours where every trade (or nearly every trade) lost.
const EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];

interface Variant {
  label: string;
  meanRevOnly: boolean;
  filterHours: boolean;
}

const VARIANTS: Variant[] = [
  { label: "Baseline (mean-rev + trend, no hour filter)", meanRevOnly: false, filterHours: false },
  { label: "Mean-reversion only (drop trend-continuation)", meanRevOnly: true, filterHours: false },
  { label: "Mean-rev + trend, hour filter applied", meanRevOnly: false, filterHours: true },
  { label: "Mean-reversion only + hour filter", meanRevOnly: true, filterHours: true },
];

function buildSignals(bars: Bar[], v: Variant): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: PARAMS.flatSlopePct, slopeLookback: PARAMS.slopeLookback });
  const trend = vwapTrendContinuation(bars, vwap, { trendSlopePct: PARAMS.trendSlopePct, slopeLookback: PARAMS.slopeLookback });
  const base = v.meanRevOnly ? meanRev : merge(meanRev, trend);
  const sized = overrideTargetR(base, TARGET_R);
  return v.filterHours ? hourFilter(bars, sized, EXCLUDED_HOURS) : sized;
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(58)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString(), excludedHours: EXCLUDED_HOURS };

  console.log("=".repeat(78));
  console.log("FULL PERIOD: NQ 5-min, all 4 variants");
  console.log("=".repeat(78));
  const fullPeriod = VARIANTS.map((v) => runStrategy(v.label, nq5m, buildSignals(nq5m, v)));
  fullPeriod.forEach(summarize);
  output.fullPeriod = fullPeriod;

  console.log("\n" + "=".repeat(78));
  console.log("SPLIT-PERIOD CHECK: does the hour filter hold up out of the sample it was diagnosed on?");
  console.log("=".repeat(78));
  const mid = Math.floor(nq5m.length / 2);
  const firstHalf = nq5m.slice(0, mid);
  const secondHalf = nq5m.slice(mid);
  const splitResults: Record<string, unknown> = {};
  for (const v of VARIANTS) {
    console.log(`\n-- ${v.label} --`);
    const full = runStrategy("Full", nq5m, buildSignals(nq5m, v));
    const h1 = runStrategy("First half", firstHalf, buildSignals(firstHalf, v));
    const h2 = runStrategy("Second half", secondHalf, buildSignals(secondHalf, v));
    [full, h1, h2].forEach(summarize);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(bothPositive ? "Verdict: POSITIVE in both halves." : "Verdict: NOT positive in both halves.");
    splitResults[v.label] = { full: full.stats, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive };
  }
  output.splitResults = splitResults;

  console.log("\n" + "=".repeat(78));
  console.log("OUT-OF-SAMPLE: identical rules run fresh on ES 5-min");
  console.log("=".repeat(78));
  const outOfSample = VARIANTS.map((v) => runStrategy(`${v.label}, ES 5-min`, es5m, buildSignals(es5m, v)));
  outOfSample.forEach(summarize);
  output.outOfSample = outOfSample;

  console.log("\n=== Ranked by full-period final equity ===");
  [...fullPeriod]
    .sort((a, b) => b.stats.finalEquity - a.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${i + 1}. ${r.strategyName} — $100 -> $${r.stats.finalEquity.toFixed(2)}, trades=${r.stats.totalTrades}, winRate=${(r.stats.winRate * 100).toFixed(1)}%`,
      ),
    );

  writeFileSync("data/refine-c1-5m-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/refine-c1-5m-results.json");
}

main();
