import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyMinute, nyWeekday } from "../src/backtest/nyTime.js";
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

// LucidFlex hard rule (verified via search): flat by 4:45pm ET, market closed until 6:00pm ET,
// Sun-Thu. No swing trading -- a position may carry through ONE evening/overnight session
// (6pm today -> 4:45pm tomorrow) but must be flat before the SECOND 4:45pm deadline it would
// otherwise cross.
//
// Finds the next 16:45 NY deadline strictly after entryBarIndex by scanning the REAL bar
// timestamps (data-driven, avoids synthetic time-stepping/DST bugs).
function nextFlatDeadlineBarTime(bars: Bar[], entryBarIndex: number): number {
  for (let i = entryBarIndex + 1; i < bars.length; i++) {
    const h = nyHour(bars[i]!.t);
    const m = nyMinute(bars[i]!.t);
    if (h === 16 && m >= 45) return bars[i]!.t;
  }
  return Infinity; // no deadline found within the data (shouldn't happen for real trades)
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  const vwap = sessionVwap(nq5m);
  const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
  const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
  const signals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);
  const result = runStrategy("flagship", nq5m, signals);

  console.log("=".repeat(110));
  console.log("Does the flagship strategy's backtest respect LucidFlex's mandatory flat-by-4:45pm-ET / no-swing rule?");
  console.log("=".repeat(110));
  console.log("Rule (verified via search): all positions flat by 4:45pm ET, market reopens 6:00pm ET Sun-Thu.");
  console.log("A trade may hold through ONE evening/overnight session but must close before crossing a SECOND 4:45pm deadline.\n");

  let violations = 0;
  const violationTrades: (Trade & { deadline: number })[] = [];

  for (const t of result.trades) {
    const entryBar = nq5m[t.barIndex]!;
    const exitBar = nq5m[t.exitBarIndex]!;
    const deadline = nextFlatDeadlineBarTime(nq5m, t.barIndex);

    if (exitBar.t > deadline) {
      violations++;
      violationTrades.push({ ...t, deadline });
    }
  }

  console.log(`Total trades: ${result.trades.length}`);
  console.log(`Trades that would be FORCE-CLOSED before reaching their backtested stop/target (held past the applicable 4:45pm deadline): ${violations}\n`);

  if (violations > 0) {
    console.log("-- Flagged trades (all times NY) --");
    for (const t of violationTrades) {
      const entryBar = nq5m[t.barIndex]!;
      const exitBar = nq5m[t.exitBarIndex]!;
      const fmt = (unixSeconds: number) => `${nyDateKey(unixSeconds)} ${String(nyHour(unixSeconds)).padStart(2, "0")}:${String(nyMinute(unixSeconds)).padStart(2, "0")}`;
      console.log(`Bar ${t.barIndex} entry ${fmt(entryBar.t)} NY -> backtested exit ${fmt(exitBar.t)} NY, deadline was ${fmt(t.deadline)} NY, backtested outcome=${t.outcome}, R=${t.rMultiple.toFixed(2)}`);
    }

    const winsAffected = violationTrades.filter((t) => t.outcome === "win").length;
    const lossesAffected = violationTrades.filter((t) => t.outcome === "loss").length;
    const rAtRisk = violationTrades.reduce((s, t) => s + t.rMultiple, 0);
    console.log(`\nOf the ${violations} flagged trades: ${winsAffected} were backtested wins, ${lossesAffected} were backtested losses.`);
    console.log(`Total R currently credited to trades whose real-world outcome is uncertain under this rule: ${rAtRisk.toFixed(2)} R (out of ${result.stats.totalR.toFixed(1)} total)`);
    console.log(`NOTE: a forced 4:45pm close does NOT necessarily mean a loss -- the trade could be force-closed at a profit, a small loss, or the full stop, depending on where price was at that moment. This is unknown without minute-level intraday tracking through the deadline, which isn't currently modeled.`);
  }

  writeFileSync(
    "data/lucid-session-realism-check-results.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalTrades: result.trades.length,
        violations,
        totalR: result.stats.totalR,
        rAtRisk: violationTrades.reduce((s, t) => s + t.rMultiple, 0),
      },
      null,
      2,
    ),
  );
  console.log("\nFull results written to data/lucid-session-realism-check-results.json");
}

main();
