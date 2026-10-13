"""CRT (Candle Range Theory) NY AM backtest for NQ on 30m / 1H / 4H.

Same rules as crt_ny_am_strategy.pine:
  C1 = range candle, C2 = next candle that sweeps one side of C1 and closes back inside.
  Bearish: C2.high > C1.high and C1.low < C2.close < C1.high  -> short
  Bullish: C2.low  < C1.low  and C1.low < C2.close < C1.high  -> long
  Entry at C2's close (open of the first base bar after C2), stop at C2's wick,
  target at the opposite side of C1. C2 must close in the NY AM window
  (09:30 < close <= 12:00 ET). Anything still open is closed at 16:00 ET.
  If a base bar touches both stop and target, the stop is assumed hit first.

Input: an intraday OHLC CSV (1m or 5m recommended), e.g. a TradingView chart export
of NQ1!. Needs a time column (unix seconds or ISO datetime) plus open/high/low/close.

    python crt_backtest.py nq_5m.csv [--tz-in UTC] [--out results.csv]
"""
import argparse
import sys

import numpy as np
import pandas as pd

NY = "America/New_York"
TIMEFRAMES = {"30m": 30, "1H": 60, "4H": 240}
WIN_FROM, WIN_TO = 9 * 60 + 30, 12 * 60
EXIT_MIN = 16 * 60


def load(path, tz_in):
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    tcol = next(c for c in df.columns if c in ("time", "datetime", "date", "timestamp"))
    t = df[tcol]
    if np.issubdtype(t.dtype, np.number):
        unit = "ms" if t.abs().max() > 1e11 else "s"
        ts = pd.to_datetime(t, unit=unit, utc=True)
    else:
        ts = pd.to_datetime(t, utc=False)
        ts = ts.dt.tz_localize(tz_in) if ts.dt.tz is None else ts
    out = df[["open", "high", "low", "close"]].astype(float)
    # naive NY wall-clock time: candle boundaries follow exchange clock across DST
    out.index = ts.dt.tz_convert(NY).dt.tz_localize(None)
    return out.sort_index()[~out.index.duplicated()]


def build_candles(base, minutes):
    if minutes == 240:
        # CME session opens 18:00 ET -> 4H candles at 18, 22, 02, 06, 10, 14
        shifted = base.index - pd.Timedelta(hours=18)
        key = shifted.floor("240min") + pd.Timedelta(hours=18)
    else:
        key = base.index.floor(f"{minutes}min")
    g = base.groupby(key)
    c = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(),
                      "low": g["low"].min(), "close": g["close"].last()})
    c["end"] = c.index + pd.Timedelta(minutes=minutes)
    return c


def simulate(base, signals):
    times = base.index.values
    hi, lo, op, cl = (base[k].values for k in ("high", "low", "open", "close"))
    trades = []
    busy_until = np.datetime64("NaT", "ns")
    for s in signals:
        i = np.searchsorted(times, np.datetime64(s["c2_close"]))
        if i >= len(times):
            continue
        if not np.isnat(busy_until) and times[i] < busy_until:
            continue  # one position at a time
        day_end = pd.Timestamp(times[i]).normalize() + pd.Timedelta(minutes=EXIT_MIN)
        entry = op[i]
        short = s["dir"] == "short"
        stop, tgt = s["stop"], s["target"]
        risk = (stop - entry) if short else (entry - stop)
        if risk <= 0 or (short and entry <= tgt) or (not short and entry >= tgt):
            continue  # gapped through stop or target before entry
        exit_px, how, j = None, None, i
        while j < len(times):
            if pd.Timestamp(times[j]) >= day_end:
                exit_px, how = op[j], "Time"
                break
            if (hi[j] >= stop) if short else (lo[j] <= stop):
                exit_px, how = stop, "SL"
                break
            if (lo[j] <= tgt) if short else (hi[j] >= tgt):
                exit_px, how = tgt, "TP"
                break
            j += 1
        if exit_px is None:
            exit_px, how, j = cl[-1], "Open", len(times) - 1
        pts = (entry - exit_px) if short else (exit_px - entry)
        busy_until = times[j]
        trades.append({**s, "entry_time": pd.Timestamp(times[i]), "entry": entry,
                       "exit_time": pd.Timestamp(times[j]), "exit": exit_px, "exit_type": how,
                       "risk_pts": risk, "reward_pts": abs(tgt - entry), "pts": pts, "R": pts / risk})
    return trades


def find_signals(c, tf):
    sigs = []
    for k in range(1, len(c)):
        c1, c2 = c.iloc[k - 1], c.iloc[k]
        end = c2["end"]
        m = end.hour * 60 + end.minute
        if not (WIN_FROM < m <= WIN_TO):
            continue
        inside = c1["low"] < c2["close"] < c1["high"]
        bear = c2["high"] > c1["high"] and inside
        bull = c2["low"] < c1["low"] and inside
        if bear == bull:  # none, or swept both sides
            continue
        sigs.append({"tf": tf, "c2_close": end, "dir": "short" if bear else "long",
                     "stop": c2["high"] if bear else c2["low"],
                     "target": c1["low"] if bear else c1["high"]})
    return sigs


def summarize(t):
    n = len(t)
    if n == 0:
        return pd.Series({"trades": 0})
    w, l = t.loc[t.R > 0, "R"].sum(), -t.loc[t.R < 0, "R"].sum()
    eq = t.R.cumsum()
    return pd.Series({
        "trades": n,
        "win_rate_%": round(100 * (t.R > 0).mean(), 1),
        "target_hit_%": round(100 * (t.exit_type == "TP").mean(), 1),
        "stopped_%": round(100 * (t.exit_type == "SL").mean(), 1),
        "time_exit_%": round(100 * (t.exit_type == "Time").mean(), 1),
        "avg_R": round(t.R.mean(), 2),
        "total_R": round(t.R.sum(), 1),
        "PF": round(w / l, 2) if l > 0 else np.inf,
        "max_DD_R": round((eq.cummax() - eq).max(), 1),
        "avg_planned_RR": round((t.reward_pts / t.risk_pts).median(), 2),
        "avg_pts": round(t.pts.mean(), 1),
    })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--tz-in", default="UTC", help="timezone of naive datetimes in the CSV")
    ap.add_argument("--out", help="write every trade to this CSV")
    a = ap.parse_args()

    base = load(a.csv, a.tz_in)
    print(f"Data: {base.index[0]} -> {base.index[-1]} NY time, {len(base):,} bars\n")
    all_trades = []
    for tf, mins in TIMEFRAMES.items():
        all_trades += simulate(base, find_signals(build_candles(base, mins), tf))
    if not all_trades:
        sys.exit("No trades found.")
    t = pd.DataFrame(all_trades)
    t["c2_close_ny"] = t.c2_close.dt.strftime("%H:%M")
    t["year"] = t.entry_time.dt.year

    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 30)
    order = list(TIMEFRAMES)
    print("=== By CRT timeframe ===")
    print(t.groupby("tf").apply(summarize, include_groups=False).reindex(order), "\n")
    print("=== By timeframe and direction ===")
    print(t.groupby(["tf", "dir"]).apply(summarize, include_groups=False), "\n")
    print("=== By timeframe and C2 close time (NY) ===")
    print(t.groupby(["tf", "c2_close_ny"]).apply(summarize, include_groups=False), "\n")
    print("=== By timeframe and year (total R) ===")
    print(t.pivot_table(index="year", columns="tf", values="R", aggfunc="sum").round(1)[
        [c for c in order if c in t.tf.unique()]])
    if a.out:
        t.to_csv(a.out, index=False)
        print(f"\nTrades written to {a.out}")


if __name__ == "__main__":
    main()
