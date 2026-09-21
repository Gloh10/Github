import type { Bar } from "./types.js";

export interface ValueArea {
  poc: number;
  vah: number;
  val: number;
}

function typicalPrice(bar: Bar): number {
  return (bar.h + bar.l + bar.c) / 3;
}

/**
 * Rolling volume-profile proxy for the order-flow "fair value area" concept:
 * bins the trailing `lookback` bars' volume by typical price into `numBins`
 * buckets, takes the point of control (highest-volume bucket), and expands
 * outward bucket-by-bucket (higher-volume side first) until `valueAreaPct`
 * of the window's total volume is enclosed. This is a standard market-profile
 * technique computed from bar volume — NOT a reconstruction of real bid/ask
 * order flow, which OHLCV bars cannot provide. The window is strictly before
 * the current bar, so there is no lookahead.
 */
export function rollingValueArea(
  bars: Bar[],
  lookback: number,
  valueAreaPct = 0.7,
  numBins = 24,
): (ValueArea | null)[] {
  const out: (ValueArea | null)[] = [];

  for (let i = 0; i < bars.length; i++) {
    if (i < lookback) {
      out.push(null);
      continue;
    }
    const window = bars.slice(i - lookback, i);

    let lo = Infinity;
    let hi = -Infinity;
    for (const b of window) {
      lo = Math.min(lo, b.l);
      hi = Math.max(hi, b.h);
    }
    if (!(hi > lo)) {
      out.push(null);
      continue;
    }

    const binSize = (hi - lo) / numBins;
    const volByBin = new Array<number>(numBins).fill(0);
    for (const b of window) {
      const tp = typicalPrice(b);
      const binIdx = Math.max(0, Math.min(numBins - 1, Math.floor((tp - lo) / binSize)));
      volByBin[binIdx]! += b.v;
    }

    const totalVolume = volByBin.reduce((s, v) => s + v, 0);
    if (totalVolume === 0) {
      out.push(null);
      continue;
    }

    let pocBin = 0;
    for (let b = 1; b < numBins; b++) {
      if (volByBin[b]! > volByBin[pocBin]!) pocBin = b;
    }

    let loBin = pocBin;
    let hiBin = pocBin;
    let enclosed = volByBin[pocBin]!;
    const target = totalVolume * valueAreaPct;
    while (enclosed < target && (loBin > 0 || hiBin < numBins - 1)) {
      const belowVol = loBin > 0 ? volByBin[loBin - 1]! : -1;
      const aboveVol = hiBin < numBins - 1 ? volByBin[hiBin + 1]! : -1;
      if (aboveVol >= belowVol) {
        hiBin++;
        enclosed += volByBin[hiBin]!;
      } else {
        loBin--;
        enclosed += volByBin[loBin]!;
      }
    }

    out.push({
      poc: lo + (pocBin + 0.5) * binSize,
      vah: lo + (hiBin + 1) * binSize,
      val: lo + loBin * binSize,
    });
  }

  return out;
}
