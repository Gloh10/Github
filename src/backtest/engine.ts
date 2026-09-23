import { nyDateKey, nyHour, nyMinute } from "./nyTime.js";
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
 * Same walk-forward stop/target resolution as simulateTrades, but adds a
 * hard session deadline: if neither stop nor target has been hit by the
 * next occurrence of `deadlineHour:deadlineMinute` (NY time) after entry,
 * the position is force-closed at that bar's close price instead of being
 * allowed to run to its target — modeling a broker/prop-firm rule that
 * requires flat positions by a fixed daily cutoff (e.g. LucidFlex's
 * 4:45pm ET flat-by rule). The deadline is found by scanning forward
 * through the actual bar timestamps, so it naturally lands on the next
 * calendar day if entry itself is already past today's cutoff.
 */
export function simulateTradesWithSessionDeadline(
  bars: Bar[],
  signals: Signal[],
  opts: { deadlineHour: number; deadlineMinute: number },
): Trade[] {
  const trades: Trade[] = [];
  let openUntilIndex = -1;

  for (const signal of signals) {
    if (signal.barIndex <= openUntilIndex) continue;

    const risk = Math.abs(signal.entry - signal.stop);
    if (risk === 0) continue;

    let exitBarIndex = bars.length - 1;
    let exitPrice = bars[bars.length - 1]!.c;

    for (let i = signal.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      const hitStop = signal.direction === "long" ? bar.l <= signal.stop : bar.h >= signal.stop;
      const hitTarget = signal.direction === "long" ? bar.h >= signal.target : bar.l <= signal.target;

      if (hitStop) {
        exitBarIndex = i;
        exitPrice = signal.stop;
        break;
      }
      if (hitTarget) {
        exitBarIndex = i;
        exitPrice = signal.target;
        break;
      }

      const h = nyHour(bar.t);
      const m = nyMinute(bar.t);
      if (h === opts.deadlineHour && m >= opts.deadlineMinute) {
        exitBarIndex = i;
        exitPrice = bar.c;
        break;
      }
    }

    const rMultiple = signal.direction === "long" ? (exitPrice - signal.entry) / risk : (signal.entry - exitPrice) / risk;
    const outcome: "win" | "loss" = rMultiple > 0 ? "win" : "loss";

    trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple });
    openUntilIndex = exitBarIndex;
  }

  return trades;
}

/**
 * Same walk-forward stop/target/session-deadline resolution as
 * simulateTradesWithSessionDeadline, plus an asymmetric circuit breaker:
 * after `lossStreakThreshold` CONSECUTIVE losses, trading pauses until a
 * cooldown ends -- either the start of the next NY calendar day
 * (cooldownMode: "restOfDay") or a fixed number of bars
 * (cooldownMode: "fixedBars", cooldownBars). A win at any point resets the
 * consecutive-loss counter to zero immediately, and there is no cap on
 * winning streaks -- the breaker only ever fires off of losses.
 */
export function simulateTradesWithCircuitBreaker(
  bars: Bar[],
  signals: Signal[],
  deadlineOpts: { deadlineHour: number; deadlineMinute: number },
  breakerOpts: { lossStreakThreshold: number; cooldownMode: "restOfDay" | "fixedBars"; cooldownBars?: number },
): Trade[] {
  const trades: Trade[] = [];
  let openUntilIndex = -1;
  let consecutiveLosses = 0;
  let cooldownUntilBarIndex = -1;

  for (const signal of signals) {
    if (signal.barIndex <= openUntilIndex) continue;
    if (signal.barIndex <= cooldownUntilBarIndex) continue;

    const risk = Math.abs(signal.entry - signal.stop);
    if (risk === 0) continue;

    let exitBarIndex = bars.length - 1;
    let exitPrice = bars[bars.length - 1]!.c;

    for (let i = signal.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      const hitStop = signal.direction === "long" ? bar.l <= signal.stop : bar.h >= signal.stop;
      const hitTarget = signal.direction === "long" ? bar.h >= signal.target : bar.l <= signal.target;

      if (hitStop) {
        exitBarIndex = i;
        exitPrice = signal.stop;
        break;
      }
      if (hitTarget) {
        exitBarIndex = i;
        exitPrice = signal.target;
        break;
      }

      const h = nyHour(bar.t);
      const m = nyMinute(bar.t);
      if (h === deadlineOpts.deadlineHour && m >= deadlineOpts.deadlineMinute) {
        exitBarIndex = i;
        exitPrice = bar.c;
        break;
      }
    }

    const rMultiple = signal.direction === "long" ? (exitPrice - signal.entry) / risk : (signal.entry - exitPrice) / risk;
    const outcome: "win" | "loss" = rMultiple > 0 ? "win" : "loss";

    trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple });
    openUntilIndex = exitBarIndex;

    if (outcome === "loss") {
      consecutiveLosses++;
      if (consecutiveLosses >= breakerOpts.lossStreakThreshold) {
        if (breakerOpts.cooldownMode === "fixedBars") {
          cooldownUntilBarIndex = exitBarIndex + (breakerOpts.cooldownBars ?? 0);
        } else {
          const exitDay = nyDateKey(bars[exitBarIndex]!.t);
          let nextDayBarIndex = bars.length - 1;
          for (let i = exitBarIndex + 1; i < bars.length; i++) {
            if (nyDateKey(bars[i]!.t) !== exitDay) {
              nextDayBarIndex = i - 1; // pause through the rest of exitDay; resumes at nextDayBarIndex+1
              break;
            }
          }
          cooldownUntilBarIndex = nextDayBarIndex;
        }
        consecutiveLosses = 0; // fresh count once trading resumes after the cooldown
      }
    } else {
      consecutiveLosses = 0; // any win clears the streak -- no cap on winning streaks
    }
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

/**
 * Same walk-forward resolution as simulateTrades, but once price moves
 * `trimAtR` multiples of risk in the trade's favor, realizes `trimFraction`
 * of the position at that level and moves the stop on the REMAINING
 * fraction to breakeven, letting it keep running toward the original
 * target. The reported rMultiple is the size-weighted blend of the
 * realized (trimmed) leg and however the remainder eventually resolves.
 * As with simulateTradesWithBreakeven, a stop/target check on a given bar
 * always uses the stop/state as of the START of that bar — the trim
 * (and its breakeven move) only takes effect for bars after the one that
 * triggered it, avoiding same-bar ordering ambiguity. In the rare case a
 * single bar's range covers both the trim level and the full target
 * before any trim has been recorded, it resolves as an untrimmed full-R
 * winner (a disclosed, deliberately simple edge-case choice).
 */
export function simulateTradesWithPartialAtR(
  bars: Bar[],
  signals: Signal[],
  opts: { trimAtR: number; trimFraction: number },
): Trade[] {
  const trades: Trade[] = [];
  let openUntilIndex = -1;

  for (const signal of signals) {
    if (signal.barIndex <= openUntilIndex) continue;

    const risk = Math.abs(signal.entry - signal.stop);
    if (risk === 0) continue;

    let trimmed = false;
    let currentStop = signal.stop;
    let realizedR = 0;
    let openFraction = 1;
    let exitBarIndex = bars.length - 1;
    let exitPrice = bars[bars.length - 1]!.c;
    let outcome: "win" | "loss" = "loss";
    let done = false;

    for (let i = signal.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      const hitStop = signal.direction === "long" ? bar.l <= currentStop : bar.h >= currentStop;
      const hitTarget = signal.direction === "long" ? bar.h >= signal.target : bar.l <= signal.target;

      if (hitStop) {
        exitBarIndex = i;
        exitPrice = currentStop;
        const legR = (signal.direction === "long" ? exitPrice - signal.entry : signal.entry - exitPrice) / risk;
        const totalR = realizedR + openFraction * legR;
        outcome = totalR > 0 ? "win" : "loss";
        trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple: totalR });
        done = true;
        break;
      }
      if (hitTarget) {
        exitBarIndex = i;
        exitPrice = signal.target;
        const legR = (signal.direction === "long" ? exitPrice - signal.entry : signal.entry - exitPrice) / risk;
        const totalR = realizedR + openFraction * legR;
        outcome = "win";
        trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple: totalR });
        done = true;
        break;
      }

      if (!trimmed) {
        const favorable = signal.direction === "long" ? bar.h - signal.entry : signal.entry - bar.l;
        if (favorable / risk >= opts.trimAtR) {
          trimmed = true;
          realizedR += opts.trimFraction * opts.trimAtR;
          openFraction = 1 - opts.trimFraction;
          currentStop = signal.entry;
        }
      }
    }

    if (!done) {
      const legR = (signal.direction === "long" ? exitPrice - signal.entry : signal.entry - exitPrice) / risk;
      const totalR = realizedR + openFraction * legR;
      trades.push({ ...signal, exitBarIndex, exitPrice, outcome: "loss", rMultiple: totalR });
    }

    openUntilIndex = exitBarIndex;
  }

  return trades;
}

/**
 * Points-based breakeven + tight-trail management, replacing the fixed
 * price target entirely (the trade rides until stopped out): as soon as
 * price moves `breakevenTriggerPoints` in favor (a near-zero value means
 * "any reaction at all"), the stop moves to breakeven. Once price has
 * moved `trailStartPoints` in favor, a trailing stop kicks in,
 * `trailDistancePoints` behind the running favorable extreme, and only
 * ever tightens (never loosens). As with the other management modes, a
 * bar's stop check always uses the stop as of the START of that bar —
 * an update triggered by a bar's own extreme takes effect from the next
 * bar onward, avoiding same-bar ordering ambiguity. signal.target is
 * ignored entirely in this mode.
 */
export function simulateTradesWithPointsTrail(
  bars: Bar[],
  signals: Signal[],
  opts: { breakevenTriggerPoints: number; trailStartPoints: number; trailDistancePoints: number },
): Trade[] {
  const trades: Trade[] = [];
  let openUntilIndex = -1;

  for (const signal of signals) {
    if (signal.barIndex <= openUntilIndex) continue;

    const risk = Math.abs(signal.entry - signal.stop);
    if (risk === 0) continue;

    let currentStop = signal.stop;
    let movedToBreakeven = false;
    let runningExtreme = signal.entry;
    let exitBarIndex = bars.length - 1;
    let exitPrice = bars[bars.length - 1]!.c;
    let outcome: "win" | "loss" = "loss";
    let done = false;

    for (let i = signal.barIndex + 1; i < bars.length; i++) {
      const bar = bars[i]!;
      const hitStop = signal.direction === "long" ? bar.l <= currentStop : bar.h >= currentStop;

      if (hitStop) {
        exitBarIndex = i;
        exitPrice = currentStop;
        const rMultiple = (signal.direction === "long" ? exitPrice - signal.entry : signal.entry - exitPrice) / risk;
        outcome = rMultiple > 0 ? "win" : "loss";
        trades.push({ ...signal, exitBarIndex, exitPrice, outcome, rMultiple });
        done = true;
        break;
      }

      runningExtreme = signal.direction === "long" ? Math.max(runningExtreme, bar.h) : Math.min(runningExtreme, bar.l);
      const favorable = signal.direction === "long" ? runningExtreme - signal.entry : signal.entry - runningExtreme;

      if (!movedToBreakeven && favorable >= opts.breakevenTriggerPoints) {
        currentStop = signal.entry;
        movedToBreakeven = true;
      }
      if (favorable >= opts.trailStartPoints) {
        const trailStop = signal.direction === "long" ? runningExtreme - opts.trailDistancePoints : runningExtreme + opts.trailDistancePoints;
        currentStop = signal.direction === "long" ? Math.max(currentStop, trailStop) : Math.min(currentStop, trailStop);
      }
    }

    if (!done) {
      const rMultiple = (signal.direction === "long" ? exitPrice - signal.entry : signal.entry - exitPrice) / risk;
      trades.push({ ...signal, exitBarIndex, exitPrice, outcome: rMultiple > 0 ? "win" : "loss", rMultiple });
    }

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
