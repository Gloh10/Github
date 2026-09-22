import { readFileSync, writeFileSync } from "node:fs";
import { buildEquityCurve, computeStats, runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

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

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function groupSummary(label: string, trades: Trade[]) {
  if (trades.length === 0) return `${label.padEnd(28)} n=0`;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const winRate = (wins / trades.length) * 100;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const avgR = totalR / trades.length;
  return `${label.padEnd(28)} n=${String(trades.length).padStart(3)}  wins=${String(wins).padStart(2)}  winRate=${winRate.toFixed(1).padStart(5)}%  totalR=${totalR.toFixed(2).padStart(7)}  avgR=${avgR.toFixed(2).padStart(6)}`;
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const vwap = sessionVwap(nq5m);
  const meanRevSignals = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trendSignals = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const filteredSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRevSignals, trendSignals)), 5);
  const result = runStrategy("flagship", nq5m, filteredSignals);
  const trades = result.trades;
  const stats = computeStats(trades, buildEquityCurve(nq5m, trades));

  console.log("=".repeat(100));
  console.log(`FLAGSHIP STRATEGY BREAKDOWN -- ${trades.length} trades, ${(stats.winRate * 100).toFixed(1)}% win rate, $100 -> $${stats.finalEquity.toFixed(2)}, maxDD=${stats.maxDrawdownPct.toFixed(1)}%`);
  console.log("=".repeat(100));

  console.log("\n-- BY SUB-STRATEGY --");
  const meanRevTrades = trades.filter((t) => t.reason.startsWith("mean-reversion"));
  const trendTrades = trades.filter((t) => t.reason.startsWith("trend continuation"));
  console.log(groupSummary("Mean-reversion", meanRevTrades));
  console.log(groupSummary("Trend continuation", trendTrades));

  console.log("\n-- BY DIRECTION --");
  console.log(groupSummary("Long", trades.filter((t) => t.direction === "long")));
  console.log(groupSummary("Short", trades.filter((t) => t.direction === "short")));

  console.log("\n-- BY SUB-STRATEGY x DIRECTION --");
  console.log(groupSummary("Mean-reversion long", meanRevTrades.filter((t) => t.direction === "long")));
  console.log(groupSummary("Mean-reversion short", meanRevTrades.filter((t) => t.direction === "short")));
  console.log(groupSummary("Trend long", trendTrades.filter((t) => t.direction === "long")));
  console.log(groupSummary("Trend short", trendTrades.filter((t) => t.direction === "short")));

  console.log("\n-- BY NY HOUR (INCLUDED HOURS ONLY -- what's actually being traded) --");
  const byHour = new Map<number, Trade[]>();
  for (const t of trades) {
    const h = nyHour(nq5m[t.barIndex]!.t);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(t);
  }
  for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
    console.log(groupSummary(`Hour ${h}:00 NY`, byHour.get(h)!));
  }

  console.log("\n-- BY NY WEEKDAY --");
  const byWeekday = new Map<number, Trade[]>();
  for (const t of trades) {
    const wd = nyWeekday(nq5m[t.barIndex]!.t);
    if (!byWeekday.has(wd)) byWeekday.set(wd, []);
    byWeekday.get(wd)!.push(t);
  }
  for (const wd of [...byWeekday.keys()].sort((a, b) => a - b)) {
    console.log(groupSummary(WEEKDAY_NAMES[wd]!, byWeekday.get(wd)!));
  }

  console.log("\n-- STREAKS --");
  let curWinStreak = 0,
    maxWinStreak = 0,
    curLossStreak = 0,
    maxLossStreak = 0;
  for (const t of trades) {
    if (t.outcome === "win") {
      curWinStreak++;
      curLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, curWinStreak);
    } else {
      curLossStreak++;
      curWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, curLossStreak);
    }
  }
  console.log(`Longest win streak: ${maxWinStreak}   Longest loss streak: ${maxLossStreak}`);

  console.log("\n-- FULL TRADE LOG (chronological) --");
  console.log("#".padEnd(4) + "Date".padEnd(12) + "Hour".padEnd(6) + "Dir".padEnd(6) + "SubStrategy".padEnd(20) + "Entry".padEnd(11) + "Stop".padEnd(11) + "R".padEnd(7) + "Outcome");
  let equity = 100;
  const curve = buildEquityCurve(nq5m, trades);
  const log = trades.map((t, i) => {
    const bar = nq5m[t.barIndex]!;
    const date = new Date(bar.t * 1000).toISOString().slice(0, 10);
    const hour = nyHour(bar.t);
    const sub = t.reason.startsWith("mean-reversion") ? "mean-reversion" : "trend-continuation";
    equity = curve[i + 1]!.equity;
    return { n: i + 1, date, hour, direction: t.direction, sub, entry: t.entry, stop: t.stop, rMultiple: t.rMultiple, outcome: t.outcome, equity };
  });
  for (const row of log) {
    console.log(
      String(row.n).padEnd(4) +
        row.date.padEnd(12) +
        String(row.hour).padEnd(6) +
        row.direction.padEnd(6) +
        row.sub.padEnd(20) +
        row.entry.toFixed(2).padEnd(11) +
        row.stop.toFixed(2).padEnd(11) +
        row.rMultiple.toFixed(2).padEnd(7) +
        row.outcome,
    );
  }

  writeFileSync(
    "data/flagship-breakdown-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        stats,
        bySubStrategy: { meanReversion: meanRevTrades.length, trendContinuation: trendTrades.length },
        streaks: { maxWinStreak, maxLossStreak },
        trades: log,
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/flagship-breakdown-results.json");
}

main();
