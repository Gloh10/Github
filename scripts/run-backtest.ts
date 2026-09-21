import { readFileSync, writeFileSync } from "node:fs";
import { buyAndHoldCurve, runStrategy } from "../src/backtest/engine.js";
import { rollingVwap, sessionVwap } from "../src/backtest/indicators.js";
import {
  subVwapTrap,
  subVwapTrapDaily,
  vwapMeanReversion,
  vwapTrendContinuation,
} from "../src/backtest/strategies.js";
import type { Bar, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Bar[];
  return raw.sort((a, b) => a.t - b.t);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(48)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  ` +
      `finalEquity=${s.finalEquity.toFixed(1)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const nq1d = loadBars("data/nq-1d.json");
  const spx1d = loadBars("data/spx-1d.json");

  console.log(`NQ 5m: ${nq5m.length} bars, ${new Date(nq5m[0]!.t * 1000).toISOString()} → ${new Date(nq5m[nq5m.length - 1]!.t * 1000).toISOString()}`);
  console.log(`NQ 1D: ${nq1d.length} bars, ${new Date(nq1d[0]!.t * 1000).toISOString()} → ${new Date(nq1d[nq1d.length - 1]!.t * 1000).toISOString()}`);
  console.log(`SPX 1D: ${spx1d.length} bars, ${new Date(spx1d[0]!.t * 1000).toISOString()} → ${new Date(spx1d[spx1d.length - 1]!.t * 1000).toISOString()}`);
  console.log("");

  // ---- 5-minute window (~26 days), session-anchored VWAP ----
  const vwap5m = sessionVwap(nq5m);

  const results5m: StrategyResult[] = [
    runStrategy(
      "1. Sub-VWAP Trap (as-specified, 10% squeeze)",
      nq5m,
      subVwapTrap(nq5m, vwap5m, { squeezeThresholdPct: 10, minFailedAttempts: 2 }),
    ),
    runStrategy(
      "1b. Sub-VWAP Trap (relaxed, 1% squeeze, 2 failed attempts)",
      nq5m,
      subVwapTrap(nq5m, vwap5m, { squeezeThresholdPct: 1, minFailedAttempts: 2 }),
    ),
    runStrategy(
      "1c. Sub-VWAP Trap (max-relaxed, 1% squeeze, 1 failed attempt)",
      nq5m,
      subVwapTrap(nq5m, vwap5m, { squeezeThresholdPct: 1, minFailedAttempts: 1 }),
    ),
    runStrategy(
      "2. VWAP Mean Reversion",
      nq5m,
      vwapMeanReversion(nq5m, vwap5m, { flatSlopePct: 0.15, slopeLookback: 12 }),
    ),
    runStrategy(
      "3. VWAP Trend Continuation",
      nq5m,
      vwapTrendContinuation(nq5m, vwap5m, { trendSlopePct: 0.15, slopeLookback: 12 }),
    ),
  ];

  console.log("=== 5-minute NQ, ~26 days (Aug 26 – Sep 21, 2026) ===");
  results5m.forEach(summarize);
  console.log("");

  // ---- Daily window (5+ years), rolling VWAP ----
  const ROLLING_LOOKBACK = 20; // ~1 trading month
  const vwapDaily = rollingVwap(nq1d, ROLLING_LOOKBACK);

  const resultsDaily: StrategyResult[] = [
    runStrategy(
      "1. Sub-VWAP Trap (daily-adapted, 10% squeeze, 2 failed attempts)",
      nq1d,
      subVwapTrapDaily(nq1d, vwapDaily, {
        squeezeLookback: ROLLING_LOOKBACK,
        squeezeThresholdPct: 10,
        minFailedAttempts: 2,
      }),
    ),
    runStrategy(
      "1c. Sub-VWAP Trap (daily-adapted, 10% squeeze, 1 failed attempt)",
      nq1d,
      subVwapTrapDaily(nq1d, vwapDaily, {
        squeezeLookback: ROLLING_LOOKBACK,
        squeezeThresholdPct: 10,
        minFailedAttempts: 1,
      }),
    ),
    runStrategy(
      "2. VWAP Mean Reversion (daily, rolling VWAP)",
      nq1d,
      vwapMeanReversion(nq1d, vwapDaily, { flatSlopePct: 1, slopeLookback: 10 }),
    ),
    runStrategy(
      "3. VWAP Trend Continuation (daily, rolling VWAP)",
      nq1d,
      vwapTrendContinuation(nq1d, vwapDaily, { trendSlopePct: 1, slopeLookback: 10 }),
    ),
  ];

  console.log("=== Daily NQ, 5+ years (Jul 2021 – Sep 2026) ===");
  resultsDaily.forEach(summarize);

  const nqBuyHoldDaily = buyAndHoldCurve(nq1d);
  const spxBuyHoldDaily = buyAndHoldCurve(spx1d);
  const nqBuyHold5m = buyAndHoldCurve(nq5m);

  console.log("");
  console.log(
    `Buy & hold NQ (daily, 5yr): finalEquity=${nqBuyHoldDaily[nqBuyHoldDaily.length - 1]!.equity.toFixed(1)}`,
  );
  console.log(
    `Buy & hold SPX (daily, 5yr): finalEquity=${spxBuyHoldDaily[spxBuyHoldDaily.length - 1]!.equity.toFixed(1)}`,
  );
  console.log(
    `Buy & hold NQ (5m, ~26d): finalEquity=${nqBuyHold5m[nqBuyHold5m.length - 1]!.equity.toFixed(1)}`,
  );

  const output = {
    generatedAt: new Date().toISOString(),
    fiveMinute: {
      windowStart: nq5m[0]!.t,
      windowEnd: nq5m[nq5m.length - 1]!.t,
      strategies: results5m,
      benchmarkNQ: nqBuyHold5m,
    },
    daily: {
      windowStart: nq1d[0]!.t,
      windowEnd: nq1d[nq1d.length - 1]!.t,
      strategies: resultsDaily,
      benchmarkNQ: nqBuyHoldDaily,
      benchmarkSPX: spxBuyHoldDaily,
    },
  };

  writeFileSync("data/backtest-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/backtest-results.json");
}

main();
