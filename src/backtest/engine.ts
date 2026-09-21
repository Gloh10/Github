import type { Bar, EquityPoint, Signal, StrategyResult, Trade } from "./types.js";

const RISK_PER_TRADE_PCT = 1; // fixed fractional risk per trade, in % of equity

/**
 * Walks forward from each signal's bar and determines whether the stop or
 * target is hit first. If a single bar's range contains both levels, the
 * stop is assumed to hit first (conservative — avoids overstating results).
 * Only one open position at a time; a new signal is ignored while a
 * position from an earlier signal is still open.
 */
export function simulateTrades(bars: Bar[], signals: Signal[]): Trade[] {
  const trades: Trade[] = [];
  let openUntilIndex = -1;

  for (const signal of signals) {
    if (signal.barIndex <= openUntilIndex) continue; // still in a position

    const risk = Math.abs(signal.entry - signal.stop);
    if (risk === 0) continue;

    let exitBarIndex = bars.length - 1;
    let exitPrice = bars[bars.length - 1]!.c;
    let outcome: "win" | "loss" = "loss";

    for (let i = signal.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      const hitStop =
        signal.direction === "long" ? bar.l <= signal.stop : bar.h >= signal.stop;
      const hitTarget =
        signal.direction === "long" ? bar.h >= signal.target : bar.l <= signal.target;

      if (hitStop) {
        exitBarIndex = i;
        exitPrice = signal.stop;
        outcome = "loss";
        break;
      }
      if (hitTarget) {
        exitBarIndex = i;
        exitPrice = signal.target;
        outcome = "win";
        break;
      }
    }

    const rMultiple =
      signal.direction === "long"
        ? (exitPrice - signal.entry) / risk
        : (signal.entry - exitPrice) / risk;

    trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple });
    openUntilIndex = exitBarIndex;
  }

  return trades;
}

/**
 * Same walk-forward stop/target resolution as simulateTrades, but supports
 * moving the stop to breakeven (the entry price) once price has moved
 * `breakevenTriggerR` multiples of the original risk in the trade's favor.
 * The move only takes effect starting the bar AFTER the one that triggered
 * it — a stop/target hit on a given bar is always resolved using the stop
 * as of the start of that bar, to avoid an ambiguous same-bar ordering
 * between "this bar triggers breakeven" and "this bar also hits the new
 * breakeven stop." Pass breakevenTriggerR = null to disable (identical to
 * simulateTrades).
 */
export function simulateTradesWithBreakeven(
  bars: Bar[],
  signals: Signal[],
  breakevenTriggerR: number | null,
): Trade[] {
  const trades: Trade[] = [];
  let openUntilIndex = -1;

  for (const signal of signals) {
    if (signal.barIndex <= openUntilIndex) continue;

    const risk = Math.abs(signal.entry - signal.stop);
    if (risk === 0) continue;

    let currentStop = signal.stop;
    let movedToBreakeven = false;
    let exitBarIndex = bars.length - 1;
    let exitPrice = bars[bars.length - 1]!.c;
    let outcome: "win" | "loss" = "loss";

    for (let i = signal.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      const hitStop = signal.direction === "long" ? bar.l <= currentStop : bar.h >= currentStop;
      const hitTarget = signal.direction === "long" ? bar.h >= signal.target : bar.l <= signal.target;

      if (hitStop) {
        exitBarIndex = i;
        exitPrice = currentStop;
        outcome = "loss";
        break;
      }
      if (hitTarget) {
        exitBarIndex = i;
        exitPrice = signal.target;
        outcome = "win";
        break;
      }

      if (breakevenTriggerR !== null && !movedToBreakeven) {
        const favorable = signal.direction === "long" ? bar.h - signal.entry : signal.entry - bar.l;
        if (favorable >= breakevenTriggerR * risk) {
          currentStop = signal.entry;
          movedToBreakeven = true;
        }
      }
    }

    const rMultiple =
      signal.direction === "long" ? (exitPrice - signal.entry) / risk : (signal.entry - exitPrice) / risk;

    trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple });
    openUntilIndex = exitBarIndex;
  }

  return trades;
}

export function buildEquityCurve(bars: Bar[], trades: Trade[]): EquityPoint[] {
  const curve: EquityPoint[] = [{ t: bars[0]?.t ?? 0, equity: 100 }];
  let equity = 100;

  for (const trade of trades) {
    equity *= 1 + (trade.rMultiple * RISK_PER_TRADE_PCT) / 100;
    curve.push({ t: bars[trade.exitBarIndex]!.t, equity });
  }
  return curve;
}

function maxDrawdownPct(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    const dd = ((peak - point.equity) / peak) * 100;
    maxDd = Math.max(maxDd, dd);
  }
  return maxDd;
}

export function computeStats(trades: Trade[], equityCurve: EquityPoint[]): StrategyResult["stats"] {
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.length - wins;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    avgR: trades.length > 0 ? totalR / trades.length : 0,
    totalR,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    finalEquity: equityCurve[equityCurve.length - 1]?.equity ?? 100,
  };
}

export function runStrategy(
  strategyName: string,
  bars: Bar[],
  signals: Signal[],
): StrategyResult {
  const trades = simulateTrades(bars, signals);
  const equityCurve = buildEquityCurve(bars, trades);

  return { strategyName, trades, equityCurve, stats: computeStats(trades, equityCurve) };
}

/** Buy-and-hold benchmark equity curve over the same bars, normalized to start at 100. */
export function buyAndHoldCurve(bars: Bar[]): EquityPoint[] {
  const startClose = bars[0]?.c ?? 1;
  return bars.map((bar) => ({ t: bar.t, equity: (bar.c / startClose) * 100 }));
}
