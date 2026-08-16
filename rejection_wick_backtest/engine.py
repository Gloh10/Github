"""
Rejection-wick backtest engine.

Strategy (as specified):
  1. A "rejection candle" is one whose upper wick (bearish) or lower wick
     (bullish) makes up at least `wick_ratio` of the candle's total range.
  2. Optionally require the wick to sweep liquidity (poke past the prior
     N-bar high/low before reversing) and/or align with the prevailing
     trend (EMA filter).
  3. Wait for a later candle to trade back into the wick, tapping the
     level where the wick began (the rejection candle's body edge on the
     wick side). Entry fills at that level, in the direction opposite the
     wick (short after an upper-wick rejection, long after a lower-wick
     rejection).
  4. Initial stop-loss sits 55% of the way through the rejection candle's
     range, measured from the low (shorts) / high (longs) — i.e. inside
     the wick, beyond the entry level, on the invalidation side.
  5. Once the trade is favorable by `trail_trigger_pts`, a trailing stop
     kicks in, trailing `trail_distance_pts` behind the best price reached,
     ratcheting only in the trade's favor, until stopped out.

All distances are in raw price points, matching the futures-points framing
in the spec (e.g. ES points).
"""
from __future__ import annotations

import dataclasses
from typing import Optional

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------

def compute_wick_features(df: pd.DataFrame) -> pd.DataFrame:
    """Adds body/range/wick columns. Expects columns open, high, low, close."""
    out = df.copy()
    out["body"] = (out["close"] - out["open"]).abs()
    out["range"] = out["high"] - out["low"]
    out["upper_wick"] = out["high"] - out[["open", "close"]].max(axis=1)
    out["lower_wick"] = out[["open", "close"]].min(axis=1) - out["low"]

    safe_range = out["range"].replace(0, np.nan)
    out["upper_wick_ratio"] = out["upper_wick"] / safe_range
    out["lower_wick_ratio"] = out["lower_wick"] / safe_range
    out[["upper_wick_ratio", "lower_wick_ratio"]] = out[
        ["upper_wick_ratio", "lower_wick_ratio"]
    ].fillna(0.0)
    return out


def add_context_filters(df: pd.DataFrame, sweep_window: int = 20, ema_period: int = 50) -> pd.DataFrame:
    out = df.copy()
    prior_high = out["high"].rolling(sweep_window).max().shift(1)
    prior_low = out["low"].rolling(sweep_window).min().shift(1)
    out["swept_prior_high"] = out["high"] > prior_high
    out["swept_prior_low"] = out["low"] < prior_low

    ema = out["close"].ewm(span=ema_period, adjust=False).mean()
    out["ema"] = ema
    out["uptrend"] = out["close"] > ema
    out["downtrend"] = out["close"] < ema
    return out


# ---------------------------------------------------------------------------
# Signal generation
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class Signal:
    idx: int
    direction: str  # "short" or "long"
    wick_start: float  # price level where the wick begins (entry trigger/level)
    stop_level: float  # initial risk stop derived from the rejection candle


def generate_signals(
    df: pd.DataFrame,
    wick_ratio: float,
    require_sweep: bool = False,
    require_trend: bool = False,
    stop_fraction: float = 0.55,
    dominance_margin: float = 0.0,
) -> list[Signal]:
    """
    dominance_margin: the dominant wick must exceed the opposite wick's
    ratio by at least this much, to avoid double-classifying doji-like bars.
    """
    signals: list[Signal] = []
    for i, row in df.iterrows():
        pos = df.index.get_loc(i)
        rng = row["range"]
        if not np.isfinite(rng) or rng <= 0:
            continue

        bearish = (
            row["upper_wick_ratio"] >= wick_ratio
            and row["upper_wick_ratio"] - row["lower_wick_ratio"] >= dominance_margin
        )
        bullish = (
            row["lower_wick_ratio"] >= wick_ratio
            and row["lower_wick_ratio"] - row["upper_wick_ratio"] >= dominance_margin
        )

        if require_sweep:
            bearish = bearish and bool(row.get("swept_prior_high", False))
            bullish = bullish and bool(row.get("swept_prior_low", False))
        if require_trend:
            bearish = bearish and bool(row.get("downtrend", False))
            bullish = bullish and bool(row.get("uptrend", False))

        if bearish:
            wick_start = max(row["open"], row["close"])  # top of body
            stop_level = row["low"] + stop_fraction * rng
            signals.append(Signal(pos, "short", wick_start, stop_level))
        elif bullish:
            wick_start = min(row["open"], row["close"])  # bottom of body
            stop_level = row["high"] - stop_fraction * rng
            signals.append(Signal(pos, "long", wick_start, stop_level))
    return signals


# ---------------------------------------------------------------------------
# Trade simulation
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class Trade:
    signal_idx: int
    entry_idx: int
    exit_idx: int
    direction: str
    entry_price: float
    exit_price: float
    initial_stop: float
    pnl_points: float
    bars_held: int
    trail_activated: bool
    win: bool


def simulate_trades(
    df: pd.DataFrame,
    signals: list[Signal],
    trail_trigger_pts: float = 5.0,
    trail_distance_pts: float = 5.0,
    max_wait_bars: int = 20,
    max_hold_bars: int = 500,
) -> list[Trade]:
    highs = df["high"].to_numpy()
    lows = df["low"].to_numpy()
    n = len(df)
    trades: list[Trade] = []
    blocked_until = -1  # avoid overlapping trades

    for sig in signals:
        if sig.idx <= blocked_until:
            continue

        # 1. Wait for a later bar to tap back into the wick.
        entry_idx = None
        for j in range(sig.idx + 1, min(sig.idx + 1 + max_wait_bars, n)):
            if sig.direction == "short" and highs[j] >= sig.wick_start:
                entry_idx = j
                break
            if sig.direction == "long" and lows[j] <= sig.wick_start:
                entry_idx = j
                break
        if entry_idx is None:
            continue

        entry_price = sig.wick_start
        current_stop = sig.stop_level
        trail_active = False
        favorable_extreme = entry_price

        # Same bar can also gap through the stop; check from entry bar onward.
        exit_idx = None
        exit_price = None
        for k in range(entry_idx, min(entry_idx + max_hold_bars, n)):
            hi, lo = highs[k], lows[k]

            if sig.direction == "short":
                favorable_extreme = min(favorable_extreme, lo)
                if not trail_active and (entry_price - favorable_extreme) >= trail_trigger_pts:
                    trail_active = True
                if trail_active:
                    current_stop = min(current_stop, favorable_extreme + trail_distance_pts)
                if hi >= current_stop:
                    exit_idx, exit_price = k, current_stop
                    break
            else:
                favorable_extreme = max(favorable_extreme, hi)
                if not trail_active and (favorable_extreme - entry_price) >= trail_trigger_pts:
                    trail_active = True
                if trail_active:
                    current_stop = max(current_stop, favorable_extreme - trail_distance_pts)
                if lo <= current_stop:
                    exit_idx, exit_price = k, current_stop
                    break

        if exit_idx is None:
            # Never stopped out within max_hold_bars: close at last available bar.
            exit_idx = min(entry_idx + max_hold_bars, n) - 1
            exit_price = df["close"].iloc[exit_idx]

        pnl = (exit_price - entry_price) if sig.direction == "long" else (entry_price - exit_price)
        trades.append(
            Trade(
                signal_idx=sig.idx,
                entry_idx=entry_idx,
                exit_idx=exit_idx,
                direction=sig.direction,
                entry_price=entry_price,
                exit_price=exit_price,
                initial_stop=sig.stop_level,
                pnl_points=pnl,
                bars_held=exit_idx - entry_idx,
                trail_activated=trail_active,
                win=pnl > 0,
            )
        )
        blocked_until = exit_idx

    return trades


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate(trades: list[Trade]) -> dict:
    if not trades:
        return dict(
            trade_count=0, win_rate=np.nan, avg_win=np.nan, avg_loss=np.nan,
            expectancy=np.nan, profit_factor=np.nan, max_drawdown=np.nan,
            total_pnl=0.0,
        )
    pnls = np.array([t.pnl_points for t in trades])
    wins = pnls[pnls > 0]
    losses = pnls[pnls <= 0]
    equity = np.cumsum(pnls)
    running_max = np.maximum.accumulate(equity)
    drawdown = running_max - equity
    gross_win = wins.sum() if len(wins) else 0.0
    gross_loss = -losses.sum() if len(losses) else 0.0

    return dict(
        trade_count=len(trades),
        win_rate=len(wins) / len(trades),
        avg_win=wins.mean() if len(wins) else 0.0,
        avg_loss=losses.mean() if len(losses) else 0.0,
        expectancy=pnls.mean(),
        profit_factor=(gross_win / gross_loss) if gross_loss > 0 else np.inf,
        max_drawdown=drawdown.max() if len(drawdown) else 0.0,
        total_pnl=pnls.sum(),
    )


# ---------------------------------------------------------------------------
# Ratio optimization
# ---------------------------------------------------------------------------

def optimize_ratio(
    df: pd.DataFrame,
    thresholds: list[float],
    require_sweep: bool = False,
    require_trend: bool = False,
    trail_trigger_pts: float = 5.0,
    trail_distance_pts: float = 5.0,
    max_wait_bars: int = 20,
    min_trades: int = 30,
) -> pd.DataFrame:
    feat = compute_wick_features(df)
    feat = add_context_filters(feat)

    rows = []
    for thresh in thresholds:
        signals = generate_signals(
            feat, wick_ratio=thresh, require_sweep=require_sweep, require_trend=require_trend
        )
        trades = simulate_trades(
            feat, signals,
            trail_trigger_pts=trail_trigger_pts,
            trail_distance_pts=trail_distance_pts,
            max_wait_bars=max_wait_bars,
        )
        metrics = evaluate(trades)
        metrics["wick_ratio"] = thresh
        metrics["meets_min_trades"] = metrics["trade_count"] >= min_trades
        rows.append(metrics)

    result = pd.DataFrame(rows).set_index("wick_ratio")
    return result[
        ["trade_count", "win_rate", "expectancy", "avg_win", "avg_loss",
         "profit_factor", "max_drawdown", "total_pnl", "meets_min_trades"]
    ]
