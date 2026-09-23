import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { keyOpenLevels } from "../src/backtest/keyOpens.js";
import { priorDayHighLow } from "../src/backtest/liquidity.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const DEADLINE = { deadlineHour: 16, deadlineMinute: 45 }; // LucidFlex, representative

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

type ConfigName = "baseline" | "dailyOpenTarget" | "4hOpenTarget" | "premiumDiscount";

function build(bars: Bar[], config: ConfigName): StrategyResult {
  let signals = baseSignals(bars);

  if (config === "dailyOpenTarget" || config === "4hOpenTarget") {
    const levels = keyOpenLevels(bars, config === "dailyOpenTarget" ? "daily" : "4h");
    signals = signals.map((s) => {
      const risk = Math.abs(s.entry - s.stop);
      const level = levels[s.barIndex]!;
      const levelAhead = s.direction === "long" ? level > s.entry : level < s.entry;
      const levelR = risk > 0 ? Math.abs(level - s.entry) / risk : 0;
      // Use the key-open level as target only when it's a plausible "magnet" distance ahead
      // (1R-10R) -- otherwise fall back to the flagship's normal R=5 fixed target.
      if (levelAhead && levelR >= 1 && levelR <= 10) {
        return { ...s, target: level, reason: s.reason + ` (target=key-open, ${levelR.toFixed(2)}R)` };
      }
      const target = s.direction === "long" ? s.entry + risk * 5 : s.entry - risk * 5;
      return { ...s, target, reason: s.reason + ` (target=fallback 5R)` };
    });
  } else if (config === "premiumDiscount") {
    const priorHL = priorDayHighLow(bars);
    signals = signals
      .filter((s) => {
        const hl = priorHL[s.barIndex]!;
        if (!isFinite(hl.high) || !isFinite(hl.low)) return false;
        const equilibrium = (hl.high + hl.low) / 2;
        // Classic ICT premium/discount: buy in the lower half of the prior-day range, sell in the upper half.
        return s.direction === "long" ? s.entry < equilibrium : s.entry > equilibrium;
      })
      .map((s) => ({ ...s }));
    signals = overrideTargetR(signals, 5);
  } else {
    signals = overrideTargetR(signals, 5);
  }

  const trades = simulateTradesWithSessionDeadline(bars, signals, DEADLINE);
  const curve = buildEquityCurve(bars, trades);
  return { strategyName: config, trades, equityCurve: curve, stats: computeStats(trades, curve) };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const rty5m = loadBars("data/rty-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const configs: ConfigName[] = ["baseline", "dailyOpenTarget", "4hOpenTarget", "premiumDiscount"];
  const labels: Record<ConfigName, string> = {
    baseline: "Baseline (fixed R=5)",
    dailyOpenTarget: "Target = daily-open magnet (1-10R band, fallback R=5)",
    "4hOpenTarget": "Target = 4h-open magnet (1-10R band, fallback R=5)",
    premiumDiscount: "Premium/discount filter (prior-day range, buy discount/sell premium)",
  };

  console.log("=".repeat(115));
  console.log("Higher-timeframe ICT concepts on the flagship: key-open magnet targeting + premium/discount filter");
  console.log("=".repeat(115));
  console.log("Grounded in the earlier reaction study (daily opens: 94.4% magnet reaction rate, 4h opens: 84.3%) --");
  console.log("this tests whether that documented effect actually improves the flagship when wired in as a target.\n");

  const fullResults: Record<string, StrategyResult> = {};
  for (const c of configs) {
    const r = build(nq5m, c);
    fullResults[c] = r;
    console.log(`${labels[c].padEnd(58)} ${summarize(r)}`);
  }
  output.fullPeriod = Object.fromEntries(configs.map((c) => [c, fullResults[c]!.stats]));

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 1: Split-period robustness");
  console.log("=".repeat(115));
  const mid = Math.floor(nq5m.length / 2);
  const splitResults: unknown[] = [];
  for (const c of configs) {
    const h1 = build(nq5m.slice(0, mid), c);
    const h2 = build(nq5m.slice(mid), c);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${labels[c].padEnd(58)} H1 totalR=${h1.stats.totalR.toFixed(1).padStart(6)}  H2 totalR=${h2.stats.totalR.toFixed(1).padStart(6)}  ${bothPositive ? "POSITIVE both" : "NOT both positive"}`);
    splitResults.push({ config: c, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 2: Transaction cost sensitivity (conservative scenario)");
  console.log("=".repeat(115));
  const costResults: unknown[] = [];
  for (const c of configs) {
    const full = fullResults[c]!;
    const costPoints = (10 + 2 * NQ_POINT_VALUE_USD) / NQ_POINT_VALUE_USD;
    const adjusted = applyCost(full.trades, costPoints);
    const curve = buildEquityCurve(nq5m, adjusted);
    const stats = computeStats(adjusted, curve);
    console.log(`${labels[c].padEnd(58)} totalR(noCost)=${full.stats.totalR.toFixed(1).padStart(6)}  totalR(cost)=${stats.totalR.toFixed(1).padStart(6)}`);
    costResults.push({ config: c, totalRNoCost: full.stats.totalR, totalRConservativeCost: stats.totalR });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(115));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES and RTY");
  console.log("=".repeat(115));
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

  writeFileSync("data/flagship-htf-ict-concepts-test-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-htf-ict-concepts-test-results.json");
}

main();
