"""Backtest the indicator's 'sweep + reclaim' signal: a bar in the killzone wicks through a FRESH key
level (PDH/PDL, PWH/PWL, Asia H/L, London H/L) and closes back. Enter next bar open, stop = wick extreme."""
import os
import sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.dirname(HERE)]
import crt_backtest as cb
from features import hourly, pivot_bias, key_levels, stats

base = cb.load(sys.argv[1], "UTC")
KZ_FROM, KZ_TO = 9 * 60 + 30, 11 * 60 + 30
COST = 0.75
bias = pivot_bias(hourly(base))
lv = key_levels(base)
idx = base.index
bar_min = int((idx[1] - idx[0]).total_seconds() // 60)
H, L, O, C = (base[k].values for k in ("high", "low", "open", "close"))
tday_arr = (idx + pd.Timedelta(hours=6)).normalize()

sigs = []
for tday, g in base.groupby(tday_arr):
    if tday not in lv.index:
        continue
    lev = lv.loc[tday]
    known = {"PDH": tday - pd.Timedelta(hours=6), "PDL": tday - pd.Timedelta(hours=6),
             "PWH": tday - pd.Timedelta(hours=6), "PWL": tday - pd.Timedelta(hours=6),
             "AH": tday, "AL": tday, "LH": tday + pd.Timedelta(hours=5), "LL": tday + pd.Timedelta(hours=5)}
    taken = set()
    for ts, row in g.iterrows():
        mins_close = (ts + pd.Timedelta(minutes=bar_min)).hour * 60 + (ts + pd.Timedelta(minutes=bar_min)).minute
        in_kz = KZ_FROM < mins_close <= KZ_TO
        for nm, k0 in known.items():
            lvl = lev[nm]
            if nm in taken or pd.isna(lvl) or ts < k0:
                continue
            buyside = nm.endswith("H")
            hit = row.high >= lvl if buyside else row.low <= lvl
            if not hit:
                continue
            taken.add(nm)
            reclaimed = row.close < lvl if buyside else row.close > lvl
            if in_kz and reclaimed:
                b = bias[bias.index <= ts + pd.Timedelta(minutes=bar_min)]
                b = b.iloc[-1] if len(b) else 0
                d = "short" if buyside else "long"
                # opposite-side unswept key levels as natural target
                opp = [lev[o] for o in (["PDL", "PWL", "AL", "LL"] if buyside else ["PDH", "PWH", "AH", "LH"])
                       if o not in taken and not pd.isna(lev[o]) and ts >= known[o]]
                sigs.append({"time": ts + pd.Timedelta(minutes=bar_min), "dir": d, "level": nm,
                             "stop": row.high if buyside else row.low, "aligned": b == (-1 if buyside else 1),
                             "opp": (max([x for x in opp if x < row.close], default=np.nan) if buyside
                                     else min([x for x in opp if x > row.close], default=np.nan))})

def run(sigs, target):
    trades, busy = [], None
    times = idx.values
    for s in sigs:
        i = np.searchsorted(times, np.datetime64(s["time"]))
        if i >= len(times) or (busy is not None and times[i] < busy):
            continue
        short = s["dir"] == "short"; e = O[i]; stop = s["stop"]
        risk = (stop - e) if short else (e - stop)
        if risk <= 0:
            continue
        if target == "opp":
            if np.isnan(s["opp"]): continue
            tgt = s["opp"]
            if (short and tgt >= e) or (not short and tgt <= e): continue
        else:
            tgt = e - target * risk if short else e + target * risk
        end = pd.Timestamp(times[i]).normalize() + pd.Timedelta(hours=16)
        j = i; px = None
        while j < len(times):
            if pd.Timestamp(times[j]) >= end: px = O[j]; break
            if (H[j] >= stop) if short else (L[j] <= stop): px = stop; break
            if (L[j] <= tgt) if short else (H[j] >= tgt): px = tgt; break
            j += 1
        if px is None: px = C[-1]; j = len(times) - 1
        pts = ((e - px) if short else (px - e)) - COST
        busy = times[j]
        trades.append({**s, "entry_time": pd.Timestamp(times[i]), "R": pts / risk, "year": pd.Timestamp(times[i]).year})
    return pd.DataFrame(trades)

pd.set_option("display.width", 200)
rows = {}
for target in [1.0, 2.0, "opp"]:
    t = run(sigs, target)
    for name, f in {"all": t.R == t.R, "bias aligned": t.aligned, "bias against": ~t.aligned}.items():
        s = t[f]; r = stats(s)
        for y in sorted(t.year.unique()):
            r[f"R {y}"] = round(s[s.year == y].R.sum(), 1)
        rows[f"target {target} | {name}"] = r
print(f"signals found: {len(sigs)}  (bar size {bar_min}m)")
print(pd.DataFrame(rows).T.to_string())
t = run(sigs, 2.0)
print("\nby level swept (target 2R):")
print(t.groupby("level").apply(stats, include_groups=False).to_string())
