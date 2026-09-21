import { readFileSync, writeFileSync } from "node:fs";
import { ALL_KEY_OPEN_TYPES, keyOpenLevels, keyOpenTriggerIndices, type KeyOpenType } from "../src/backtest/keyOpens.js";
import type { Bar } from "../src/backtest/types.js";

function loadBars(path: string): Bar[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as Bar[]).sort((a, b) => a.t - b.t);
}

const WINDOW_BARS = 24; // 2 hours on 5-min bars
const AWAY_THRESHOLD_POINTS = 15; // "moved away" from the open
const RETURN_TOLERANCE_POINTS = 5; // "returned to" the open

interface ReactionStats {
  type: KeyOpenType;
  triggers: number;
  movedAway: number;
  returnedAfterMovingAway: number; // count and rate
  returnRate: number;
  avgNetMovePoints: number; // signed, at end of window vs. open level
  avgAbsMovePoints: number;
  pctAboveAtWindowEnd: number;
}

function studyReaction(bars: Bar[], type: KeyOpenType): ReactionStats {
  const levels = keyOpenLevels(bars, type);
  const triggers = keyOpenTriggerIndices(bars, type).filter((i) => i + WINDOW_BARS < bars.length);

  let movedAway = 0;
  let returned = 0;
  let netMoveSum = 0;
  let absMoveSum = 0;
  let aboveCount = 0;

  for (const i of triggers) {
    const openLevel = bars[i]!.o;
    let didMoveAway = false;
    let didReturn = false;

    for (let j = i + 1; j <= i + WINDOW_BARS; j++) {
      const bar = bars[j]!;
      const distFromOpenHigh = Math.abs(bar.h - openLevel);
      const distFromOpenLow = Math.abs(bar.l - openLevel);
      const maxDist = Math.max(distFromOpenHigh, distFromOpenLow);
      if (maxDist >= AWAY_THRESHOLD_POINTS) didMoveAway = true;
      if (didMoveAway && Math.min(distFromOpenHigh, distFromOpenLow) <= RETURN_TOLERANCE_POINTS) {
        didReturn = true;
      }
    }

    if (didMoveAway) movedAway++;
    if (didMoveAway && didReturn) returned++;

    const endClose = bars[i + WINDOW_BARS]!.c;
    const net = endClose - openLevel;
    netMoveSum += net;
    absMoveSum += Math.abs(net);
    if (endClose > openLevel) aboveCount++;

    void levels; // levels array kept for potential future use / debugging
  }

  return {
    type,
    triggers: triggers.length,
    movedAway,
    returnedAfterMovingAway: returned,
    returnRate: movedAway > 0 ? returned / movedAway : 0,
    avgNetMovePoints: triggers.length > 0 ? netMoveSum / triggers.length : 0,
    avgAbsMovePoints: triggers.length > 0 ? absMoveSum / triggers.length : 0,
    pctAboveAtWindowEnd: triggers.length > 0 ? aboveCount / triggers.length : 0,
  };
}

function main() {
  const nq5m = loadBars("data/nq-5m.json");
  console.log(`NQ 5m: ${nq5m.length} bars (~26 days). Window=${WINDOW_BARS} bars (2h), away>=${AWAY_THRESHOLD_POINTS}pt, return<=${RETURN_TOLERANCE_POINTS}pt.\n`);

  const results = ALL_KEY_OPEN_TYPES.map((t) => studyReaction(nq5m, t));

  console.log("Type      triggers  movedAway  returnRate  avgNetMove  avgAbsMove  %aboveAtEnd");
  for (const r of results) {
    console.log(
      `${r.type.padEnd(9)} ${String(r.triggers).padStart(8)}  ${String(r.movedAway).padStart(9)}  ` +
        `${(r.returnRate * 100).toFixed(1).padStart(9)}%  ${r.avgNetMovePoints.toFixed(1).padStart(10)}  ` +
        `${r.avgAbsMovePoints.toFixed(1).padStart(10)}  ${(r.pctAboveAtWindowEnd * 100).toFixed(1).padStart(10)}%`,
    );
  }

  console.log(
    "\nreturnRate = of the times price moved >=15pt away from the open within 2h, how often it came back within 5pt.\n" +
      "A rate well above/below 50% would suggest a real magnet or anti-magnet effect; near 50% suggests no edge either way.",
  );

  writeFileSync("data/key-opens-reaction-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), config: { WINDOW_BARS, AWAY_THRESHOLD_POINTS, RETURN_TOLERANCE_POINTS }, results }, null, 2));
  console.log("\nFull results written to data/key-opens-reaction-results.json");
}

main();
