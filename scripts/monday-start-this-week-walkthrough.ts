import { readFileSync, writeFileSync } from "node:fs";
import { simulateTradesWithSessionDeadline } from "../src/backtest/engine.js";
import { sessionVwap } from "../src/backtest/indicators.js";
import { nyDateKey, nyHour, nyWeekday } from "../src/backtest/nyTime.js";
import { vwapMeanReversion, vwapTrendContinuation } from "../src/backtest/strategies.js";
import type { Bar, Signal, Trade } from "../src/backtest/types.js";

const NQ_POINT_VALUE_USD = 20;
const ACCOUNT_SIZE = 150_000;
const COMBINE_TARGET = 9_000;
const WEEK_START = "2026-09-22"; // Monday

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
function buildDayBuckets(bars: Bar[], trades: Trade[]): { day: string; trades: Trade[] }[] {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = nyDateKey(bars[t.barIndex]!.t);
    if (key < WEEK_START) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, trades]) => ({ day, trades }));
}

const nq5m = loadBars("data/nq-5m.json");
const vwap = sessionVwap(nq5m);
const meanRev = vwapMeanReversion(nq5m, vwap, { flatSlopePct: 0.15, slopeLookback: 12 });
const trend = vwapTrendContinuation(nq5m, vwap, { trendSlopePct: 0.15, slopeLookback: 12 });
const baseSignals = overrideTargetR(dayHourFilter(nq5m, merge(meanRev, trend)), 5);

function pnlOf(t: Trade): number {
  const riskPoints = Math.abs(t.entry - t.stop);
  return t.rMultiple * riskPoints * NQ_POINT_VALUE_USD;
}

function printWeek(label: string, dayBuckets: { day: string; trades: Trade[] }[]) {
  console.log(`\n${"=".repeat(100)}\n${label}\n${"=".repeat(100)}`);
  let running = 0;
  for (const { day, trades } of dayBuckets) {
    const dayPnl = trades.reduce((s, t) => s + pnlOf(t), 0);
    running += dayPnl;
    const detail = trades.map((t) => `${t.direction[0]!.toUpperCase()}${t.rMultiple > 0 ? "+" : ""}${t.rMultiple.toFixed(0)}R`).join(" ");
    console.log(`${day}  ${trades.length} trade(s) [${detail.padEnd(20)}]  day P&L: ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(0).padStart(6)}   running: ${running >= 0 ? "+" : ""}$${running.toFixed(0)}`);
  }
}

// ============================================================================
// LucidFlex 150K: DD 4500 lockable at +4600+100, target 9000, 50% consistency
// ============================================================================
{
  const trades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 45 });
  const dayBuckets = buildDayBuckets(nq5m, trades);
  printWeek("LucidFlex 150K -- eval opened Monday Sep 22 (4:45pm ET flat-by)", dayBuckets);

  const DD = 4_500;
  let balance = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD;
  let locked = false;
  let combineDays = 0;
  const dailyPnL: number[] = [];
  let busted = false;
  let bustedOn = "";

  for (const { day, trades: dayTrades } of dayBuckets) {
    let dayPnl = 0;
    for (const t of dayTrades) {
      const pnl = pnlOf(t);
      balance += pnl;
      dayPnl += pnl;
      if (balance < floor) { busted = true; bustedOn = day; break; }
    }
    if (busted) break;
    if (!locked) {
      if (balance > ACCOUNT_SIZE + DD + 100) { locked = true; floor = ACCOUNT_SIZE + 100; }
      else floor = Math.max(floor, balance - DD);
    }
    combineDays++;
    dailyPnL.push(dayPnl);
  }
  const totalProfit = balance - ACCOUNT_SIZE;
  const bestDay = dailyPnL.length ? Math.max(...dailyPnL) : 0;
  const consistencyOk = totalProfit <= 0 || bestDay <= 0.5 * totalProfit;
  const cleared = !busted && totalProfit >= COMBINE_TARGET && consistencyOk;
  console.log(`\nStatus as of today: ${busted ? `BUSTED on ${bustedOn}` : cleared ? "CLEARED THE EVAL" : "still in eval, alive"}`);
  console.log(`Balance: $${balance.toFixed(0)}  |  Total P&L: ${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(0)}  |  Drawdown floor: $${floor.toFixed(0)}  |  Cushion to floor: $${(balance - floor).toFixed(0)}`);
  console.log(`Distance to $9,000 target: $${Math.max(0, COMBINE_TARGET - totalProfit).toFixed(0)} more needed`);
}

// ============================================================================
// MyFundedFutures Pro 150K: DD 4600 peak-trailing (per-trade), target 9000, 2-day min
// ============================================================================
{
  const trades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 10 });
  const dayBuckets = buildDayBuckets(nq5m, trades);
  printWeek("MyFundedFutures Pro 150K -- eval opened Monday Sep 22 (4:10pm ET flat-by)", dayBuckets);

  const DD = 4_600;
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let combineDays = 0;
  let busted = false;
  let bustedOn = "";

  for (const { day, trades: dayTrades } of dayBuckets) {
    for (const t of dayTrades) {
      const pnl = pnlOf(t);
      balance += pnl;
      peak = Math.max(peak, balance);
      if (peak - balance >= DD) { busted = true; bustedOn = day; break; }
    }
    if (busted) break;
    combineDays++;
  }
  const totalProfit = balance - ACCOUNT_SIZE;
  const cleared = !busted && totalProfit >= COMBINE_TARGET && combineDays >= 2;
  console.log(`\nStatus as of today: ${busted ? `BUSTED on ${bustedOn}` : cleared ? "CLEARED THE EVAL" : "still in eval, alive"}`);
  console.log(`Balance: $${balance.toFixed(0)}  |  Total P&L: ${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(0)}  |  Peak: $${peak.toFixed(0)}  |  Cushion to $${(DD).toFixed(0)} trailing floor: $${(DD - (peak - balance)).toFixed(0)}`);
  console.log(`Distance to $9,000 target: $${Math.max(0, COMBINE_TARGET - totalProfit).toFixed(0)} more needed`);
}

// ============================================================================
// Apex 150K: DD 5000 lockable at +5000+100, target 9000, 1-day min in eval
// ============================================================================
{
  const trades = simulateTradesWithSessionDeadline(nq5m, baseSignals, { deadlineHour: 16, deadlineMinute: 59 });
  const dayBuckets = buildDayBuckets(nq5m, trades);
  printWeek("Apex 150K -- eval opened Monday Sep 22 (4:59pm ET flat-by)", dayBuckets);

  const DD = 5_000;
  let balance = ACCOUNT_SIZE;
  let peak = ACCOUNT_SIZE;
  let floor = ACCOUNT_SIZE - DD;
  let locked = false;
  let combineDays = 0;
  let busted = false;
  let bustedOn = "";

  for (const { day, trades: dayTrades } of dayBuckets) {
    for (const t of dayTrades) {
      const pnl = pnlOf(t);
      balance += pnl;
      peak = Math.max(peak, balance);
      if (balance < floor) { busted = true; bustedOn = day; break; }
      if (!locked) {
        if (peak >= ACCOUNT_SIZE + DD + 100) { locked = true; floor = ACCOUNT_SIZE + 100; }
        else floor = Math.max(floor, peak - DD);
      }
    }
    if (busted) break;
    combineDays++;
  }
  const totalProfit = balance - ACCOUNT_SIZE;
  const cleared = !busted && totalProfit >= COMBINE_TARGET && combineDays >= 1;
  console.log(`\nStatus as of today: ${busted ? `BUSTED on ${bustedOn}` : cleared ? "CLEARED THE EVAL" : "still in eval, alive"}`);
  console.log(`Balance: $${balance.toFixed(0)}  |  Total P&L: ${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(0)}  |  Drawdown floor: $${floor.toFixed(0)}  |  Cushion to floor: $${(balance - floor).toFixed(0)}`);
  console.log(`Distance to $9,000 target: $${Math.max(0, COMBINE_TARGET - totalProfit).toFixed(0)} more needed`);
}
