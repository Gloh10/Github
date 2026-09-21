import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { orbBreakout, valueAreaFade } from "../src/backtest/strategies.js";
import { rollingValueArea } from "../src/backtest/volumeProfile.js";
import type { Bar, Signal, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function merge(...lists: Signal[][]): Signal[] {
  return lists.flat().sort((a, b) => a.barIndex - b.barIndex);
}

/** Keeps only signals from `base` that fall within `toleranceBars` of a same-direction signal from `filter`. */
function confluenceFilter(base: Signal[], filter: Signal[], toleranceBars: number): Signal[] {
  return base.filter((b) =>
    filter.some((f) => f.direction === b.direction && Math.abs(f.barIndex - b.barIndex) <= toleranceBars),
  );
}

/** Drops signals from `base` that conflict (opposite direction) with a nearby signal from `other`. */
function excludeConflicts(base: Signal[], other: Signal[], toleranceBars: number): Signal[] {
  return base.filter(
    (b) => !other.some((o) => o.direction !== b.direction && Math.abs(o.barIndex - b.barIndex) <= toleranceBars),
  );
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(62)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  ` +
      `$100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  console.log(
    `NQ 5m: ${nq5m.length} bars, ${new Date(nq5m[0]!.t * 1000).toISOString()} -> ${new Date(nq5m[nq5m.length - 1]!.t * 1000).toISOString()}`,
  );
  console.log("");

  // ---- Setup 7a: Opening Range Breakout + volume participation filter ----
  const orb5min = orbBreakout(nq5m, { orBars: 1, volumeLookback: 20, volumeMultiplier: 1.2, targetR: 2 });
  const orb15min = orbBreakout(nq5m, { orBars: 3, volumeLookback: 20, volumeMultiplier: 1.2, targetR: 2 });
  const orb15minStrict = orbBreakout(nq5m, { orBars: 3, volumeLookback: 20, volumeMultiplier: 1.5, targetR: 2 });

  // ---- Setup 7b: Failed-auction fade at rolling value-area edges ----
  const va48 = rollingValueArea(nq5m, 48, 0.7, 24); // ~4h trailing window
  const va96 = rollingValueArea(nq5m, 96, 0.7, 24); // ~8h trailing window

  const fade48Poc = valueAreaFade(nq5m, va48, { targetMode: "poc" });
  const fade96Poc = valueAreaFade(nq5m, va96, { targetMode: "poc" });
  const fade48Edge = valueAreaFade(nq5m, va48, { targetMode: "oppositeEdge" });

  console.log("=== Setup 7a: ORB + volume participation (baselines) ===");
  const orbBaselines: StrategyResult[] = [
    runStrategy("7a-i. ORB 5-min range, vol>=1.2x avg, 2R target", nq5m, orb5min),
    runStrategy("7a-ii. ORB 15-min range, vol>=1.2x avg, 2R target", nq5m, orb15min),
    runStrategy("7a-iii. ORB 15-min range, vol>=1.5x avg (strict), 2R target", nq5m, orb15minStrict),
  ];
  orbBaselines.forEach(summarize);
  console.log("");

  console.log("=== Setup 7b: Value-area fade (baselines) ===");
  const fadeBaselines: StrategyResult[] = [
    runStrategy("7b-i. Fade VA edge, 48-bar (~4h) profile, target=POC", nq5m, fade48Poc),
    runStrategy("7b-ii. Fade VA edge, 96-bar (~8h) profile, target=POC", nq5m, fade96Poc),
    runStrategy("7b-iii. Fade VA edge, 48-bar (~4h) profile, target=opposite edge", nq5m, fade48Edge),
  ];
  fadeBaselines.forEach(summarize);
  console.log("");

  // ---- Combinations of A and B ----
  console.log("=== Combinations (A x B) ===");
  const combos: StrategyResult[] = [];

  combos.push(
    runStrategy("C1. Kitchen sink: ORB(15m) + Fade(48,POC) merged, first signal wins", nq5m, merge(orb15min, fade48Poc)),
  );

  combos.push(
    runStrategy(
      "C2. Fade(48,POC), excluding fades that conflict with a nearby ORB(15m) breakout (+/-6 bars)",
      nq5m,
      excludeConflicts(fade48Poc, orb15min, 6),
    ),
  );

  combos.push(
    runStrategy(
      "C3. ORB(15m), excluding breakouts that conflict with a nearby Fade(48,POC) signal (+/-6 bars)",
      nq5m,
      excludeConflicts(orb15min, fade48Poc, 6),
    ),
  );

  combos.push(
    runStrategy(
      "C4. ORB(15m) confirmed by a same-direction Fade signal within 12 bars (continuation-after-reversal)",
      nq5m,
      confluenceFilter(orb15min, fade48Poc, 12),
    ),
  );

  combos.push(
    runStrategy(
      "C5. Kitchen sink: every 7a/7b variant merged, first signal wins",
      nq5m,
      merge(orb5min, orb15min, orb15minStrict, fade48Poc, fade96Poc, fade48Edge),
    ),
  );

  combos.push(
    runStrategy(
      "C6. Fade(96,POC), excluding fades that conflict with a nearby ORB(15m) breakout (+/-6 bars)",
      nq5m,
      excludeConflicts(fade96Poc, orb15min, 6),
    ),
  );

  combos.forEach(summarize);

  const all = [...orbBaselines, ...fadeBaselines, ...combos];

  console.log("\n=== Ranked by final equity from $100 (ALL variants tried) ===");
  [...all]
    .sort((a, b) => b.stats.finalEquity - a.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${String(i + 1).padStart(2)}. ${r.strategyName} — $100 -> $${r.stats.finalEquity.toFixed(2)}, trades=${r.stats.totalTrades}, totalR=${r.stats.totalR.toFixed(1)}`,
      ),
    );

  console.log("\n=== Ranked by totalR (ALL variants tried) ===");
  [...all]
    .sort((a, b) => b.stats.totalR - a.stats.totalR)
    .forEach((r, i) =>
      console.log(`${String(i + 1).padStart(2)}. ${r.strategyName} — totalR=${r.stats.totalR.toFixed(1)}, trades=${r.stats.totalTrades}`),
    );

  writeFileSync(
    "data/setup7-results.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), orbBaselines, fadeBaselines, combos }, null, 2),
  );
  console.log("\nFull results written to data/setup7-results.json");
}

main();
