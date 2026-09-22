import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, StrategyResult, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;

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

interface VariantConfig {
  label: string;
  includeTrend: boolean;
  excludedHours: number[];
  excludedWeekdays: number[]; // 0=Sun .. 6=Sat, in addition to the standard Sunday/Monday-early rules
}

const BASE_EXCLUDED_HOURS = [4, 8, 10, 12, 13, 18, 19, 23];
const EXCLUDED_MONDAY_HOURS = [1, 2, 3];

const VARIANTS: VariantConfig[] = [
  { label: "V0: Baseline (current flagship)", includeTrend: true, excludedHours: BASE_EXCLUDED_HOURS, excludedWeekdays: [] },
  { label: "V1: Mean-reversion only", includeTrend: false, excludedHours: BASE_EXCLUDED_HOURS, excludedWeekdays: [] },
  { label: "V2: V1 + exclude hour 5", includeTrend: false, excludedHours: [...BASE_EXCLUDED_HOURS, 5], excludedWeekdays: [] },
  { label: "V3: V2 + exclude Tue/Wed", includeTrend: false, excludedHours: [...BASE_EXCLUDED_HOURS, 5], excludedWeekdays: [2, 3] },
];

function buildSignals(bars: Bar[], cfg: VariantConfig): Signal[] {
  const vwap = sessionVwap(bars);
  const meanRev = vwapMeanReversion(bars, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = cfg.includeTrend ? vwapTrendContinuation(bars, vwap, { trendSlopePct: 0.15, slopeLookback: 12 }) : [];
  const merged = merge(meanRev, trend);
  const filtered = merged.filter((s) => {
    const bar = bars[s.barIndex]!;
    const hour = nyHour(bar.t);
    const weekday = nyWeekday(bar.t);
    if (cfg.excludedHours.includes(hour)) return false;
    if (weekday === 0) return false;
    if (weekday === 1 && EXCLUDED_MONDAY_HOURS.includes(hour)) return false;
    if (cfg.excludedWeekdays.includes(weekday)) return false;
    return true;
  });
  return overrideTargetR(filtered, 5);
}

function run(bars: Bar[], cfg: VariantConfig, name: string): StrategyResult {
  const signals = buildSignals(bars, cfg);
  return runStrategy(name, bars, signals);
}

function summarize(result: StrategyResult): string {
  const s = result.stats;
  return `trades=${String(s.totalTrades).padStart(3)}  winRate=${(s.winRate * 100).toFixed(1).padStart(5)}%  avgR=${s.avgR.toFixed(2).padStart(6)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDrawdownPct.toFixed(1).padStart(5)}%  $100 -> $${s.finalEquity.toFixed(2)}`;
}

function applyCost(trades: Trade[], costPoints: number): Trade[] {
  return trades.map((t) => {
    const riskPoints = Math.abs(t.entry - t.stop);
    const costR = riskPoints > 0 ? costPoints / riskPoints : 0;
    return { ...t, rMultiple: t.rMultiple - costR };
  });
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const es5m = loadBars("data/es-5m.json");
  const output: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  console.log("=".repeat(105));
  console.log("BASELINE COMPARISON -- all variants, full period, NQ 5-min");
  console.log("=".repeat(105));
  const fullResults = VARIANTS.map((cfg) => run(nq5m, cfg, cfg.label));
  fullResults.forEach((r) => console.log(`${r.strategyName.padEnd(38)} ${summarize(r)}`));
  output.fullPeriod = fullResults.map((r) => ({ label: r.strategyName, ...r.stats }));

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 1: Split-period robustness (every variant, both halves must be net positive)");
  console.log("=".repeat(105));
  const mid = Math.floor(nq5m.length / 2);
  const firstHalf = nq5m.slice(0, mid);
  const secondHalf = nq5m.slice(mid);
  console.log(`First half:  ${new Date(firstHalf[0]!.t * 1000).toISOString().slice(0, 10)} -> ${new Date(firstHalf[firstHalf.length - 1]!.t * 1000).toISOString().slice(0, 10)}`);
  console.log(`Second half: ${new Date(secondHalf[0]!.t * 1000).toISOString().slice(0, 10)} -> ${new Date(secondHalf[secondHalf.length - 1]!.t * 1000).toISOString().slice(0, 10)}\n`);
  const splitResults: unknown[] = [];
  for (const cfg of VARIANTS) {
    const h1 = run(firstHalf, cfg, cfg.label);
    const h2 = run(secondHalf, cfg, cfg.label);
    const bothPositive = h1.stats.totalR > 0 && h2.stats.totalR > 0;
    console.log(`${cfg.label.padEnd(38)} H1: ${summarize(h1)}`);
    console.log(`${"".padEnd(38)} H2: ${summarize(h2)}   ${bothPositive ? "POSITIVE both halves" : "NOT positive both halves"}`);
    splitResults.push({ label: cfg.label, firstHalf: h1.stats, secondHalf: h2.stats, bothPositive });
  }
  output.splitPeriod = splitResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 2: Transaction cost sensitivity (every variant)");
  console.log("=".repeat(105));
  const costScenarios = [
    { label: "No cost", usd: 0 },
    { label: "Low-cost (~$5 + 0.5pt slip)", usd: 5 + 0.5 * NQ_POINT_VALUE_USD },
    { label: "Typical retail (~$8 + 1pt slip)", usd: 8 + 1 * NQ_POINT_VALUE_USD },
    { label: "Conservative (~$10 + 2pt slip)", usd: 10 + 2 * NQ_POINT_VALUE_USD },
  ];
  const costResults: unknown[] = [];
  for (const cfg of VARIANTS) {
    const raw = run(nq5m, cfg, cfg.label);
    console.log(`${cfg.label}:`);
    const scenarioResults: unknown[] = [];
    for (const scenario of costScenarios) {
      const costPoints = scenario.usd / NQ_POINT_VALUE_USD;
      const adjusted = applyCost(raw.trades, costPoints);
      const curve = buildEquityCurve(nq5m, adjusted);
      const stats = computeStats(adjusted, curve);
      console.log(`  ${scenario.label.padEnd(32)} ($${scenario.usd.toFixed(2)}/trade) totalR=${stats.totalR.toFixed(1).padStart(6)}  finalEquity=$${stats.finalEquity.toFixed(1)}`);
      scenarioResults.push({ ...scenario, totalR: stats.totalR, finalEquity: stats.finalEquity });
    }
    costResults.push({ label: cfg.label, scenarios: scenarioResults });
  }
  output.costResults = costResults;

  console.log("\n" + "=".repeat(105));
  console.log("CHECK 3: Out-of-sample -- identical rules run fresh on ES 5-min");
  console.log("=".repeat(105));
  const oosResults: unknown[] = [];
  for (const cfg of VARIANTS) {
    const r = run(es5m, cfg, cfg.label);
    console.log(`${r.strategyName.padEnd(38)} ${summarize(r)}`);
    oosResults.push({ label: cfg.label, ...r.stats });
  }
  output.outOfSample = oosResults;

  console.log("\n" + "=".repeat(105));
  console.log("VERDICT");
  console.log("=".repeat(105));
  for (const cfg of VARIANTS) {
    const full = fullResults.find((r) => r.strategyName === cfg.label)!;
    const split = (splitResults as { label: string; bothPositive: boolean }[]).find((s) => s.label === cfg.label)!;
    const oos = oosResults.find((r: any) => r.label === cfg.label) as any;
    const oosPositive = oos.totalR > 0;
    console.log(`${cfg.label.padEnd(38)} fullPeriodAvgR=${full.stats.avgR.toFixed(2).padStart(6)}  splitBothPositive=${split.bothPositive ? "YES" : "NO "}  OOS(ES)Positive=${oosPositive ? "YES" : "NO "}`);
  }

  writeFileSync("data/flagship-tweaks-validation-results.json", JSON.stringify(output, null, 2));
  console.log("\nFull results written to data/flagship-tweaks-validation-results.json");
}

main();
