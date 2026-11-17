import { nyDateKey, nyWeekday } from "./nyTime.js";
import type { Bar } from "./types.js";

/**
 * Groups daily bars into calendar weeks (Monday-start, NY calendar) and
 * aggregates each group into a single weekly bar. Assumes bars are already
 * sorted ascending by t and are one-per-NY-trading-day (as daily OHLCV is).
 * A week's bar.t is its first (Monday-or-later) trading day's timestamp —
 * i.e. the week's open time, consistent with how daily bars use session-open
 * timestamps elsewhere in this project.
 */
export function resampleToWeekly(dailyBars: Bar[]): Bar[] {
  const weeks: Bar[][] = [];
  let current: Bar[] = [];
  let prevWeekday = -1;

  for (const bar of dailyBars) {
    const weekday = nyWeekday(bar.t); // 0=Sun..6=Sat
    // A new week starts whenever weekday resets to <= prevWeekday (handles
    // Mon-Fri sequences and any gaps/holidays without needing ISO week math).
    if (current.length > 0 && weekday <= prevWeekday) {
      weeks.push(current);
      current = [];
    }
    current.push(bar);
    prevWeekday = weekday;
  }
  if (current.length > 0) weeks.push(current);

  return weeks.map(aggregateGroup);
}

/** Groups daily bars into calendar months (NY calendar) and aggregates each into a single monthly bar. */
export function resampleToMonthly(dailyBars: Bar[]): Bar[] {
  const months = new Map<string, Bar[]>();
  for (const bar of dailyBars) {
    const key = nyDateKey(bar.t).slice(0, 7); // YYYY-MM
    if (!months.has(key)) months.set(key, []);
    months.get(key)!.push(bar);
  }
  return [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, group]) => aggregateGroup(group));
}

function aggregateGroup(group: Bar[]): Bar {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  return {
    t: first.t,
    o: first.o,
    h: Math.max(...group.map((b) => b.h)),
    l: Math.min(...group.map((b) => b.l)),
    c: last.c,
    v: group.reduce((s, b) => s + b.v, 0),
  };
}
