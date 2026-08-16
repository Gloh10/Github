"""CSV data loading + resampling for the rejection-wick backtester.

Expects a CSV with a datetime column and OHLCV columns. Column names are
matched case-insensitively against common exports (TradingView, NinjaTrader,
Databento, IBKR, etc.):
    datetime/date/time/timestamp -> index
    open/o, high/h, low/l, close/c, volume/vol/v -> ohlcv
"""
from __future__ import annotations

import pandas as pd

_COLUMN_ALIASES = {
    "open": {"open", "o"},
    "high": {"high", "h"},
    "low": {"low", "l"},
    "close": {"close", "c"},
    "volume": {"volume", "vol", "v"},
}
_TIME_ALIASES = {"datetime", "date", "time", "timestamp"}


def load_ohlcv_csv(path: str) -> pd.DataFrame:
    raw = pd.read_csv(path)
    cols_lower = {c.lower().strip(): c for c in raw.columns}

    time_col = next((cols_lower[a] for a in _TIME_ALIASES if a in cols_lower), None)
    if time_col is None:
        raise ValueError(
            f"No datetime column found in {path}. Expected one of {_TIME_ALIASES}."
        )

    rename = {}
    for canonical, aliases in _COLUMN_ALIASES.items():
        match = next((cols_lower[a] for a in aliases if a in cols_lower), None)
        if match is None and canonical != "volume":
            raise ValueError(f"No '{canonical}' column found in {path}.")
        if match is not None:
            rename[match] = canonical

    df = raw.rename(columns=rename)
    df[time_col] = pd.to_datetime(df[time_col])
    df = df.set_index(time_col).sort_index()
    df.index.name = "datetime"

    keep = ["open", "high", "low", "close"] + (["volume"] if "volume" in df.columns else [])
    df = df[keep].astype({c: "float64" for c in keep if c != "volume"})
    return df


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample e.g. 1-minute bars up to '3min', '5min', '15min', '1h'."""
    agg = {"open": "first", "high": "max", "low": "min", "close": "last"}
    if "volume" in df.columns:
        agg["volume"] = "sum"
    out = df.resample(rule).agg(agg).dropna(subset=["open", "high", "low", "close"])
    return out
