import { nyHour, nyMinute, nyWeekday } from "./nyTime.js";
import type { Bar } from "./types.js";

export type KeyOpenType = "daily" | "4h" | "ny" | "london" | "asia" | "830" | "weekly";

/**
 * Definitions used (times in America/New_York, DST-aware). These are
 * conventional but not universal — different traders draw session
 * boundaries a little differently, so these are disclosed explicitly:
 *  - daily:   00:00 (midnight open)
 *  - 4h:      00:00 / 04:00 / 08:00 / 12:00 / 16:00 / 20:00
 *  - ny:      09:30 (cash market / "New York" open)
 *  - london:  03:00 (London session open)
 *  - asia:    18:00 (Asia/Tokyo session open — also the futures day rollover)
 *  - 830:     08:30 (the major US economic-release time — CPI/NFP/FOMC, etc.)
 *  - weekly:  Sunday 18:00 (futures week open)
 */
function isKeyOpenBar(bar: Bar, type: KeyOpenType): boolean {
  const hour = nyHour(bar.t);
  const minute = nyMinute(bar.t);
  switch (type) {
    case "daily":
      return hour === 0 && minute < 5;
    case "4h":
      return hour % 4 === 0 && minute < 5;
    case "ny":
      return hour === 9 && minute >= 30 && minute < 35;
    case "london":
      return hour === 3 && minute < 5;
    case "asia":
      return hour === 18 && minute < 5;
    case "830":
      return hour === 8 && minute >= 30 && minute < 35;
    case "weekly":
      return nyWeekday(bar.t) === 0 && hour === 18 && minute < 5;
  }
}

/**
 * For each bar, the open price of the most recent key-open of the given
 * type at or before that bar (carried forward; falls back to the very
 * first bar's open before the first occurrence in the dataset).
 */
export function keyOpenLevels(bars: Bar[], type: KeyOpenType): number[] {
  const out: number[] = [];
  let current = bars[0]?.o ?? 0;
  for (const bar of bars) {
    if (isKeyOpenBar(bar, type)) current = bar.o;
    out.push(current);
  }
  return out;
}

/** Bar indices where a new key-open of the given type forms. */
export function keyOpenTriggerIndices(bars: Bar[], type: KeyOpenType): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (isKeyOpenBar(bars[i]!, type)) out.push(i);
  }
  return out;
}

export const ALL_KEY_OPEN_TYPES: KeyOpenType[] = ["daily", "4h", "ny", "london", "asia", "830", "weekly"];
