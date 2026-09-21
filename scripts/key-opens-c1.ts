import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { ALL_KEY_OPEN_TYPES, keyOpenLevels, type KeyOpenType } from "../src/backtest/keyOpens.js";
import { sessionVwap } from "../src/backtest/indicators.js";
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

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(62)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

/** Keeps only signals whose entry is within `tolerancePoints` of at least one of the given key-open levels at that bar. */
function nearKeyOpenFilter(
  bars: Bar[],
  signals: Signal[],
  levelsByType: Map<KeyOpenType, number[]>,
  types: KeyOpenType[],
  tolerancePoints: number,
): Signal[] {
  return signals.filter((s) => {
    return types.some((t) => {
      const level = levelsByType.get(t)![s.barIndex]!;
      return Math.abs(s.entry - level) <= tolerancePoints;
    });
  });
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const params = { flatSlopePct: 0.15, trendSlopePct: 0.15, slopeLookback: 12 };
  const targetR = 5;

  const vwap = sessionVwap(nq5m);
  const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: params.flatSlopePct, slopeLookback: params.slopeLookback });
  const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: params.trendSlopePct, slopeLookback: params.slopeLookback });
  const baseSignals = overrideTargetR(merge(meanRev, trend), targetR);

  const baseline = runStrategy("Baseline: 5-min C1, R=5, no breakeven (as previously validated)", nq5m, baseSignals);
  summarize(baseline);
  console.log("");

  const levelsByType = new Map<KeyOpenType, number[]>();
  for (const t of ALL_KEY_OPEN_TYPES) levelsByType.set(t, keyOpenLevels(nq5m, t));

  // Strong-magnet types per the reaction study (returnRate well above 50%): daily, 4h, ny, london, 830.
  // Excludes asia (~50%, no edge) and weekly (too few samples, 4 triggers, to trust).
  const strongTypes: KeyOpenType[] = ["daily", "4h", "ny", "london", "830"];

  const variants: { label: string; types: KeyOpenType[]; tolerance: number }[] = [
    { label: "All 7 key-open types, 10pt tolerance", types: ALL_KEY_OPEN_TYPES, tolerance: 10 },
    { label: "All 7 key-open types, 20pt tolerance", types: ALL_KEY_OPEN_TYPES, tolerance: 20 },
    { label: "All 7 key-open types, 30pt tolerance", types: ALL_KEY_OPEN_TYPES, tolerance: 30 },
    { label: "Strong-magnet types only (daily/4h/ny/london/830), 10pt", types: strongTypes, tolerance: 10 },
    { label: "Strong-magnet types only (daily/4h/ny/london/830), 20pt", types: strongTypes, tolerance: 20 },
    { label: "Strong-magnet types only (daily/4h/ny/london/830), 30pt", types: strongTypes, tolerance: 30 },
    { label: "Daily open only, 10pt tolerance", types: ["daily"], tolerance: 10 },
    { label: "Daily open only, 20pt tolerance", types: ["daily"], tolerance: 20 },
    { label: "Daily + 4h open only, 10pt tolerance", types: ["daily", "4h"], tolerance: 10 },
    { label: "Daily + 4h open only, 20pt tolerance", types: ["daily", "4h"], tolerance: 20 },
  ];

  console.log("=== Key-open confluence filter variants (5-min C1, R=5) ===");
  const results: StrategyResult[] = [];
  for (const v of variants) {
    const filtered = nearKeyOpenFilter(nq5m, baseSignals, levelsByType, v.types, v.tolerance);
    const result = runStrategy(v.label, nq5m, filtered);
    summarize(result);
    results.push(result);
  }

  console.log("\n=== Ranked by final equity from $100 (baseline + all filter variants) ===");
  [baseline, ...results]
    .sort((a, b) => b.stats.finalEquity - a.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${String(i + 1).padStart(2)}. ${r.strategyName} — $100 -> $${r.stats.finalEquity.toFixed(2)}, trades=${r.stats.totalTrades}, winRate=${(r.stats.winRate * 100).toFixed(1)}%, totalR=${r.stats.totalR.toFixed(1)}`,
      ),
    );

  writeFileSync(
    "data/key-opens-c1-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), baseline, variants: results }, null, 2),
  );
  console.log("\nFull results written to data/key-opens-c1-results.json");
}

main();
