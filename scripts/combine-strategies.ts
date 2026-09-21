import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { rollingVwap, sessionVwap } from "../src/backtest/indicators.js";
import {
  detectSfps,
  standardDeviationOte,
  swingFailurePatternEntries,
  vwapMeanReversion,
  vwapTrendContinuation,
} from "../src/backtest/strategies.js";
import { buildLegs, findPivots, sdLevels } from "../src/backtest/swings.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

/** Merge signal lists from multiple strategies sharing the same bars array, sorted by time. */
function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}

/** Keeps only signals from `base` that fall within `toleranceBars` of a signal from `filter` in the same direction. */
function confluenceFilter(base: Signal[], filter: Signal[], toleranceBars: number): Signal[] {
  return base.filter((b) =>
    filter.some((f) => f.direction === b.direction && Math.abs(f.barIndex - b.barIndex) <= toleranceBars),
  );
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(58)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  ` +
      `finalEquity=${s.finalEquity.toFixed(1)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const nq1d = loadBars("data/nq-1d.json");
  const nq1h = loadBars("data/nq-1h.json");
  const es5m = loadBars("data/es-5m.json");

  const vwap5m = sessionVwap(nq5m);
  const vwapDaily = rollingVwap(nq1d, 20);

  // ---- Base signal sets, reused as building blocks ----
  const daily_meanRev = vwapMeanReversion(nq1d, vwapDaily, { flatSlopePct: 1, slopeLookback: 10 });
  const daily_trend = vwapTrendContinuation(nq1d, vwapDaily, { trendSlopePct: 1, slopeLookback: 10 });

  const fivemin_meanRev = vwapMeanReversion(nq5m, vwap5m, { flatSlopePct: 0.15, slopeLookback: 12 });
  const fivemin_trend = vwapTrendContinuation(nq5m, vwap5m, { trendSlopePct: 0.15, slopeLookback: 12 });
  const fivemin_sdote = standardDeviationOte(nq5m, { pivotConfirm: 3, minConfluence: 3, toleranceFraction: 0.0015 });

  const sfps = detectSfps(nq1h, { pivotConfirm: 2, biasFilter: "none" });
  const fivemin_sfp = swingFailurePatternEntries(nq5m, sfps, nq1h, { fvgWindowBars: 24, targetR: 2 });

  console.log("=== Individual strategies (baseline, already reported previously) ===");
  const baselines: StrategyResult[] = [
    runStrategy("Daily: Mean Reversion (Setup 2)", nq1d, daily_meanRev),
    runStrategy("Daily: Trend Continuation (Setup 3)", nq1d, daily_trend),
    runStrategy("5m: Mean Reversion (Setup 2)", nq5m, fivemin_meanRev),
    runStrategy("5m: Trend Continuation (Setup 3)", nq5m, fivemin_trend),
    runStrategy("5m: SD+OTE, confluence>=3 (Setup 5d)", nq5m, fivemin_sdote),
    runStrategy("5m: SFP + FVG, unfiltered (Setup 6a)", nq5m, fivemin_sfp),
  ];
  baselines.forEach(summarize);
  console.log("");

  // ---- Combinations ----
  console.log("=== Combinations ===");
  const combos: StrategyResult[] = [];

  // Combo 1: Daily regime-adaptive — mean-reversion when flat, trend-continuation when sloped.
  // These are already mutually exclusive by construction (same slope threshold), so this is a
  // genuine "run both, whichever regime you're in" unified strategy, not just double-counting.
  combos.push(
    runStrategy("C1. Daily: Mean-Rev + Trend-Continuation merged (regime-adaptive)", nq1d, merge(daily_meanRev, daily_trend)),
  );

  // Combo 2: 5m regime-adaptive, same idea intraday.
  combos.push(
    runStrategy("C2. 5m: Mean-Rev + Trend-Continuation merged (regime-adaptive)", nq5m, merge(fivemin_meanRev, fivemin_trend)),
  );

  // Combo 3: Daily trend-continuation, filtered to only fire near a daily-timeframe SD extension level
  // (reusing the swings.ts leg/SD-projection tool built for Setup 5, applied to daily bars this time).
  {
    const dailyPivots = findPivots(nq1d, 5);
    const dailyLegs = buildLegs(dailyPivots).slice(-30);
    const sdSignalsAsFilter: Signal[] = [];
    for (const leg of dailyLegs) {
      const levels = sdLevels(leg, [2, 2.5, 4, 4.5]);
      for (let i = leg.extremeIndex; i < nq1d.length; i++) {
        for (const level of Object.values(levels)) {
          if (nq1d[i]!.l <= level && nq1d[i]!.h >= level) {
            sdSignalsAsFilter.push({
              barIndex: i,
              direction: leg.direction === "up" ? "long" : "short",
              entry: nq1d[i]!.c,
              stop: nq1d[i]!.l,
              target: leg.originPrice,
              reason: "sd-level-touch (filter only)",
            });
          }
        }
      }
    }
    const filtered = confluenceFilter(daily_trend, sdSignalsAsFilter, 3);
    combos.push(runStrategy("C3. Daily: Trend-Continuation, confirmed by an SD-level touch within 3 bars", nq1d, filtered));
  }

  // Combo 4: 5m SFP entries, filtered to only fire when the 5m VWAP trend agrees with the SFP direction.
  {
    const filtered = confluenceFilter(fivemin_sfp, fivemin_trend, 12);
    combos.push(runStrategy("C4. 5m: SFP+FVG, confirmed by VWAP trend agreement (+/-12 bars)", nq5m, filtered));
  }

  // Combo 5: 5m SD+OTE entries, filtered to require an SFP nearby (cross-strategy confluence
  // between the two ICT-style setups, both built from the same 4-video source material).
  {
    const filtered = confluenceFilter(fivemin_sdote, fivemin_sfp, 12);
    combos.push(runStrategy("C5. 5m: SD+OTE, confirmed by a nearby SFP+FVG signal", nq5m, filtered));
  }

  // Combo 6: "Kitchen sink" — every 5m intraday signal merged into one strategy, whichever fires first wins the slot.
  combos.push(
    runStrategy(
      "C6. 5m: everything merged (MeanRev + Trend + SD-OTE + SFP), first signal wins",
      nq5m,
      merge(fivemin_meanRev, fivemin_trend, fivemin_sdote, fivemin_sfp),
    ),
  );

  combos.forEach(summarize);

  const ranked = [...baselines, ...combos].sort((a, b) => b.stats.totalR - a.stats.totalR);
  console.log("\n=== Ranked by totalR (ALL variants tried, not just the winner) ===");
  ranked.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${r.strategyName} — totalR=${r.stats.totalR.toFixed(1)}, trades=${r.stats.totalTrades}`));

  writeFileSync(
    "data/combination-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), baselines, combos, esBarsUsed: es5m.length }, null, 2),
  );
  console.log("\nFull results written to data/combination-results.json");
}

main();
