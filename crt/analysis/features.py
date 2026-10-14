"""Attach liquidity-script features to CRT trades: 1H pivot bias, key-level sweep by C2."""
import os
import sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.dirname(HERE)]
import crt_backtest as cb


def hourly(base):
    return base.resample("1h").agg({"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()


def pivot_bias(h):
    """Port of the indicator's f_bias(): pivots(2,2), close beyond last pivot flips bias. Index = bar close time."""
    hi, lo, cl = h.high.values, h.low.values, h.close.values
    n = len(h); b = np.zeros(n, int); lh = ll = np.nan; cur = 0
    for i in range(n):
        j = i - 2  # pivot candidate confirmed now
        if j >= 2:
            if hi[j] > max(hi[j-2:j]) and hi[j] >= max(hi[j+1:i+1]):
                lh = hi[j]
            if lo[j] < min(lo[j-2:j]) and lo[j] <= min(lo[j+1:i+1]):
                ll = lo[j]
        if not np.isnan(lh) and cl[i] > lh: cur = 1
        if not np.isnan(ll) and cl[i] < ll: cur = -1
        b[i] = cur
    return pd.Series(b, index=h.index + pd.Timedelta(hours=1))


def key_levels(base):
    """Per trading day D: PDH/PDL, PWH/PWL, Asia (20-24 ET, evening before D), London (02-05 ET) with time they become known."""
    df = base.copy()
    df["tday"] = (df.index + pd.Timedelta(hours=6)).normalize()
    df["hr"] = df.index.hour
    d = df.groupby("tday").agg(dh=("high", "max"), dl=("low", "min"))
    d["PDH"], d["PDL"] = d.dh.shift(1), d.dl.shift(1)
    wk = d.index.to_period("W")
    w = d.groupby(wk).agg(wh=("dh", "max"), wl=("dl", "min")).shift(1)
    d["PWH"], d["PWL"] = w.wh.reindex(wk).values, w.wl.reindex(wk).values
    asia = df[df.hr >= 20].groupby("tday").agg(AH=("high", "max"), AL=("low", "min"))
    lon = df[(df.hr >= 2) & (df.hr < 5)].groupby("tday").agg(LH=("high", "max"), LL=("low", "min"))
    return d.join(asia).join(lon)


def add_features(trades, base, minutes):
    h = hourly(base)
    bias = pivot_bias(h)
    lv = key_levels(base)
    rows = []
    for _, t in trades.iterrows():
        c2c = t.c2_close; c2s = c2c - pd.Timedelta(minutes=minutes)
        c2 = base[(base.index >= c2s) & (base.index < c2c)]
        tday = (c2s + pd.Timedelta(hours=6)).normalize()
        L = lv.loc[tday] if tday in lv.index else None
        b = bias[bias.index <= c2c].iloc[-1] if (bias.index <= c2c).any() else 0
        short = t.dir == "short"
        swept, fresh = [], []
        if L is not None:
            names = ["PDH", "PWH", "AH", "LH"] if short else ["PDL", "PWL", "AL", "LL"]
            for nm in names:
                lvl = L[nm]
                if pd.isna(lvl):
                    continue
                if short:
                    hit = c2.high.max() >= lvl > c2.close.iloc[-1]
                else:
                    hit = c2.low.min() <= lvl < c2.close.iloc[-1]
                if hit:
                    swept.append(nm)
                    # fresh = not traded through earlier in the trading day before C2 started
                    day_start = tday - pd.Timedelta(hours=6)
                    if nm in ("AH", "AL"):
                        day_start = tday            # Asia known at 00:00
                    if nm in ("LH", "LL"):
                        day_start = tday + pd.Timedelta(hours=5)
                    prior = base[(base.index >= day_start) & (base.index < c2s)]
                    taken = (prior.high.max() >= lvl) if short else (prior.low.min() <= lvl)
                    if not taken:
                        fresh.append(nm)
        rows.append({"bias": b, "aligned": (b == -1) if short else (b == 1),
                     "key_sweep": len(swept) > 0, "fresh_sweep": len(fresh) > 0,
                     "levels": "+".join(swept),
                     "rr": t.reward_pts / t.risk_pts})
    return pd.concat([trades.reset_index(drop=True), pd.DataFrame(rows)], axis=1)


def stats(t):
    if len(t) == 0:
        return pd.Series({"n": 0})
    w, l = t.R[t.R > 0].sum(), -t.R[t.R < 0].sum()
    eq = t.R.cumsum()
    return pd.Series({"n": len(t), "win%": round(100 * (t.R > 0).mean()), "avgR": round(t.R.mean(), 3),
                      "totR": round(t.R.sum(), 1), "PF": round(w / l, 2) if l else np.inf,
                      "maxDD": round((eq.cummax() - eq).max(), 1)})
