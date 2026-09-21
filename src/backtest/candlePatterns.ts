import type { Bar } from "./types.js";

function body(bar: Bar): number {
  return Math.abs(bar.c - bar.o);
}
function range(bar: Bar): number {
  return bar.h - bar.l;
}
function upperWick(bar: Bar): number {
  return bar.h - Math.max(bar.o, bar.c);
}
function lowerWick(bar: Bar): number {
  return Math.min(bar.o, bar.c) - bar.l;
}
function isBullish(bar: Bar): boolean {
  return bar.c > bar.o;
}
function isBearish(bar: Bar): boolean {
  return bar.c < bar.o;
}

/** Small body near the bottom of the range, long upper wick — bearish reversal. */
export function isShootingStar(bar: Bar): boolean {
  const r = range(bar);
  if (r === 0) return false;
  const b = body(bar);
  return upperWick(bar) >= 2 * b && lowerWick(bar) <= r * 0.1 && b <= r * 0.35;
}

/** Small body near the top of the range, long lower wick — bullish reversal. */
export function isHammer(bar: Bar): boolean {
  const r = range(bar);
  if (r === 0) return false;
  const b = body(bar);
  return lowerWick(bar) >= 2 * b && upperWick(bar) <= r * 0.1 && b <= r * 0.35;
}

/** Bearish candle fully engulfed by the following bullish candle's body. */
export function isBullishEngulfing(prev: Bar, cur: Bar): boolean {
  return (
    isBearish(prev) &&
    isBullish(cur) &&
    cur.o <= prev.c &&
    cur.c >= prev.o &&
    body(cur) > body(prev)
  );
}

/** Bullish candle fully engulfed by the following bearish candle's body. */
export function isBearishEngulfing(prev: Bar, cur: Bar): boolean {
  return (
    isBullish(prev) &&
    isBearish(cur) &&
    cur.o >= prev.c &&
    cur.c <= prev.o &&
    body(cur) > body(prev)
  );
}
