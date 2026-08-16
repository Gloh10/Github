"""
CLI entry point: run the rejection-wick ratio optimization across one or
more timeframes built from a single OHLCV CSV (ideally 1-minute bars, which
get resampled down to 3min/5min/15min/1h).

Usage:
    python3 run_backtest.py --csv path/to/ohlcv_1min.csv \
        --timeframes 1min:3min,1min:5min,1min:15min,1min:1h \
        --thresholds 0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9 \
        --sweep --trend

    # If you already have separate files per timeframe:
    python3 run_backtest.py --csv-map 1h=es_1h.csv,15min=es_15m.csv,5min=es_5m.csv,3min=es_3m.csv
"""
from __future__ import annotations

import argparse

import pandas as pd

from data import load_ohlcv_csv, resample
from engine import optimize_ratio


def parse_thresholds(s: str) -> list[float]:
    return [float(x) for x in s.split(",") if x.strip()]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--csv", help="Path to a single (ideally 1-minute) OHLCV CSV.")
    p.add_argument(
        "--timeframes", default="1min:3min,1min:5min,1min:15min,1min:1h",
        help="Comma list of base:target resample pairs when using --csv.",
    )
    p.add_argument(
        "--csv-map", default=None,
        help="Comma list of label=path.csv, one file per timeframe (skips resampling).",
    )
    p.add_argument("--thresholds", default="0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9")
    p.add_argument("--sweep", action="store_true", help="Require liquidity-sweep context.")
    p.add_argument("--trend", action="store_true", help="Require trend-aligned context.")
    p.add_argument("--trail-trigger", type=float, default=5.0)
    p.add_argument("--trail-distance", type=float, default=5.0)
    p.add_argument("--min-trades", type=int, default=30)
    args = p.parse_args()

    thresholds = parse_thresholds(args.thresholds)
    frames: dict[str, pd.DataFrame] = {}

    if args.csv_map:
        for pair in args.csv_map.split(","):
            label, path = pair.split("=")
            frames[label] = load_ohlcv_csv(path)
    elif args.csv:
        base = load_ohlcv_csv(args.csv)
        for pair in args.timeframes.split(","):
            _, target = pair.split(":")
            frames[target] = resample(base, target)
    else:
        raise SystemExit("Provide either --csv (with --timeframes) or --csv-map.")

    for label, df in frames.items():
        print(f"\n=== {label} ({len(df)} bars, {df.index.min()} -> {df.index.max()}) ===")
        result = optimize_ratio(
            df, thresholds,
            require_sweep=args.sweep, require_trend=args.trend,
            trail_trigger_pts=args.trail_trigger, trail_distance_pts=args.trail_distance,
            min_trades=args.min_trades,
        )
        print(result.round(4).to_string())

        eligible = result[result["meets_min_trades"]]
        if len(eligible):
            best = eligible["win_rate"].idxmax()
            print(f"-> best wick_ratio by win rate (>= {args.min_trades} trades): {best} "
                  f"(win_rate={eligible.loc[best, 'win_rate']:.3f}, "
                  f"trades={int(eligible.loc[best, 'trade_count'])})")
        else:
            print(f"-> no threshold reached {args.min_trades} trades; lower --min-trades or widen data.")


if __name__ == "__main__":
    main()
