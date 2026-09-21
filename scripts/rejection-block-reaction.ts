import { readFileSync, writeFileSync } from "node:fs";
import { rejectionBlock } from "../src/backtest/strategies.js";
import type { Bar } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

const FORWARD_BARS = [1, 3, 5, 10, 20];

function studyTimeframe(label: string, bars: Bar[]) {
  // Use the "alone" (no FVG confluence) detector, R irrelevant here since we're
  // only reading the direction/barIndex/entry/stop off each detected block.
  const signals = rejectionBlock(bars, { pivotConfirm: 3, targetR: 2, requireFvgConfluence: false, fvgToleranceFraction: 0.0015 });
  const shorts = signals.filter((s) => s.direction === "short");
  const longs = signals.filter((s) => s.direction === "long");

  console.log(`\n=== ${label} (${signals.length} rejection blocks: ${shorts.length} bearish, ${longs.length} bullish) ===`);

  // Null baseline: over the WHOLE dataset, what fraction of bars close lower (or higher) k bars later?
  function nullRate(k: number, direction: "down" | "up"): number {
    let count = 0;
    let total = 0;
    for (let i = 0; i + k < bars.length; i++) {
      total++;
      if (direction === "down" ? bars[i + k]!.c < bars[i]!.c : bars[i + k]!.c > bars[i]!.c) count++;
    }
    return total > 0 ? count / total : 0;
  }

  function signalRate(sigs: typeof signals, k: number, direction: "down" | "up"): { rate: number; avgMoveR: number; n: number } {
    let count = 0;
    let n = 0;
    let moveRSum = 0;
    for (const s of sigs) {
      const i = s.barIndex;
      if (i + k >= bars.length) continue;
      n++;
      const risk = Math.abs(s.entry - s.stop);
      const move = bars[i + k]!.c - bars[i]!.c; // signed
      const favorable = direction === "down" ? -move : move;
      if (favorable > 0) count++;
      moveRSum += risk > 0 ? favorable / risk : 0;
    }
    return { rate: n > 0 ? count / n : 0, avgMoveR: n > 0 ? moveRSum / n : 0, n };
  }

  console.log("Bearish rejection blocks: does price close LOWER k bars later, vs. the dataset's baseline down-rate?");
  console.log("k".padEnd(6) + "signalRate".padStart(12) + "nullRate".padStart(12) + "edge".padStart(10) + "avgMoveR".padStart(11) + "n".padStart(6));
  for (const k of FORWARD_BARS) {
    const sig = signalRate(shorts, k, "down");
    const nul = nullRate(k, "down");
    console.log(
      String(k).padEnd(6) +
        `${(sig.rate * 100).toFixed(1)}%`.padStart(12) +
        `${(nul * 100).toFixed(1)}%`.padStart(12) +
        `${((sig.rate - nul) * 100).toFixed(1)}pp`.padStart(10) +
        sig.avgMoveR.toFixed(2).padStart(11) +
        String(sig.n).padStart(6),
    );
  }

  console.log("Bullish rejection blocks: does price close HIGHER k bars later, vs. the dataset's baseline up-rate?");
  console.log("k".padEnd(6) + "signalRate".padStart(12) + "nullRate".padStart(12) + "edge".padStart(10) + "avgMoveR".padStart(11) + "n".padStart(6));
  for (const k of FORWARD_BARS) {
    const sig = signalRate(longs, k, "up");
    const nul = nullRate(k, "up");
    console.log(
      String(k).padEnd(6) +
        `${(sig.rate * 100).toFixed(1)}%`.padStart(12) +
        `${(nul * 100).toFixed(1)}%`.padStart(12) +
        `${((sig.rate - nul) * 100).toFixed(1)}pp`.padStart(10) +
        sig.avgMoveR.toFixed(2).padStart(11) +
        String(sig.n).padStart(6),
    );
  }

  return { label, totalSignals: signals.length, shorts: shorts.length, longs: longs.length };
}

function main() {
  const timeframes: { label: string; file: string }[] = [
    { label: "5-min", file: "data/nq-5m.json" },
    { label: "15-min", file: "data/nq-15m.json" },
    { label: "1-hour", file: "data/nq-1h.json" },
    { label: "1-day", file: "data/nq-1d.json" },
  ];

  const summaryOut: unknown[] = [];
  for (const tf of timeframes) {
    const bars = loadBars(tf.file);
    summaryOut.push(studyTimeframe(tf.label, bars));
  }

  writeFileSync("data/rejection-block-reaction-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), forwardBars: FORWARD_BARS, summary: summaryOut }, null, 2));
  console.log("\nSummary written to data/rejection-block-reaction-results.json (console output above has the full per-k breakdown)");
}

main();
