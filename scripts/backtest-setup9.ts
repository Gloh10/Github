import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy } from "../src/backtest/engine.js";
import { ALL_KEY_OPEN_TYPES, keyOpenLevels, type KeyOpenType } from "../src/backtest/keyOpens.js";
import { dailyBiasKeyOpenFuel } from "../src/backtest/strategies.js";
import type { Bar, StrategyResult } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

function summarize(result: StrategyResult) {
  const s = result.stats;
  console.log(
    `${result.strategyName.padEnd(58)} trades=${String(s.totalTrades).padStart(4)}  ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%  avgR=${s.avgR.toFixed(2)}  ` +
      `totalR=${s.totalR.toFixed(1)}  maxDD=${s.maxDrawdownPct.toFixed(1)}%  $100 -> $${s.finalEquity.toFixed(2)}`,
  );
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  console.log(`NQ 5m: ${nq5m.length} bars (~26 days)\n`);

  const levelsByType = new Map<KeyOpenType, number[]>();
  for (const t of ALL_KEY_OPEN_TYPES) levelsByType.set(t, keyOpenLevels(nq5m, t));

  // Strong-magnet types per the reaction study (daily 94.4%, 4h 84.3%, 830 78.9%, london 77.8%, ny 73.7%).
  const strongTypes: KeyOpenType[] = ["daily", "4h", "ny", "london", "830"];

  const variants: {
    label: string;
    fuelTypes: KeyOpenType[];
    sweepReclaimWindowBars: number;
    fallbackTargetR: number;
    minFuelR?: number;
    maxFuelR?: number;
  }[] = [
    { label: "Strong-magnet fuel, 6-bar (30min) reclaim window", fuelTypes: strongTypes, sweepReclaimWindowBars: 6, fallbackTargetR: 4 },
    { label: "Strong-magnet fuel, 12-bar (1h) reclaim window", fuelTypes: strongTypes, sweepReclaimWindowBars: 12, fallbackTargetR: 4 },
    { label: "Strong-magnet fuel, 24-bar (2h) reclaim window", fuelTypes: strongTypes, sweepReclaimWindowBars: 24, fallbackTargetR: 4 },
    { label: "All 7 key-open types as fuel, 12-bar reclaim window", fuelTypes: ALL_KEY_OPEN_TYPES, sweepReclaimWindowBars: 12, fallbackTargetR: 4 },
    { label: "Daily + 4h fuel only, 12-bar reclaim window", fuelTypes: ["daily", "4h"], sweepReclaimWindowBars: 12, fallbackTargetR: 4 },
    // R-bounded: only use a fuel level as the target if it offers a sane 1.5R-4R; else fall back to a fixed R.
    { label: "R-bounded (1.5R-4R): strong-magnet fuel, 12-bar reclaim", fuelTypes: strongTypes, sweepReclaimWindowBars: 12, fallbackTargetR: 2, minFuelR: 1.5, maxFuelR: 4 },
    { label: "R-bounded (1.5R-4R): all 7 types as fuel, 12-bar reclaim", fuelTypes: ALL_KEY_OPEN_TYPES, sweepReclaimWindowBars: 12, fallbackTargetR: 2, minFuelR: 1.5, maxFuelR: 4 },
    { label: "R-bounded (2R-5R): strong-magnet fuel, 12-bar reclaim", fuelTypes: strongTypes, sweepReclaimWindowBars: 12, fallbackTargetR: 3, minFuelR: 2, maxFuelR: 5 },
    { label: "R-bounded (1R-3R): strong-magnet fuel, 12-bar reclaim", fuelTypes: strongTypes, sweepReclaimWindowBars: 12, fallbackTargetR: 2, minFuelR: 1, maxFuelR: 3 },
  ];

  console.log("=== Setup 9: Daily bias (liquidity sweep + reclaim) + key-open fuel target ===");
  const results: StrategyResult[] = [];
  for (const v of variants) {
    const signals = dailyBiasKeyOpenFuel(nq5m, levelsByType, v.fuelTypes, {
      sweepReclaimWindowBars: v.sweepReclaimWindowBars,
      fallbackTargetR: v.fallbackTargetR,
      minFuelR: v.minFuelR,
      maxFuelR: v.maxFuelR,
    });
    const fuelHitCount = signals.filter((s) => !s.reason.includes("fallback")).length;
    const result = runStrategy(v.label, nq5m, signals);
    summarize(result);
    console.log(`   (of ${signals.length} signals, ${fuelHitCount} targeted a real key-open level, ${signals.length - fuelHitCount} used the fallback R)`);
    results.push(result);
  }

  console.log("\n=== Ranked by final equity from $100 ===");
  [...results]
    .sort((a, b) => b.stats.finalEquity - a.stats.finalEquity)
    .forEach((r, i) =>
      console.log(
        `${String(i + 1).padStart(2)}. ${r.strategyName} — $100 -> $${r.stats.finalEquity.toFixed(2)}, trades=${r.stats.totalTrades}, winRate=${(r.stats.winRate * 100).toFixed(1)}%, totalR=${r.stats.totalR.toFixed(1)}, maxDD=${r.stats.maxDrawdownPct.toFixed(1)}%`,
      ),
    );

  writeFileSync("data/setup9-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nFull results written to data/setup9-results.json");
}

main();
