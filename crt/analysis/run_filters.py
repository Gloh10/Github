import os
import sys
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.dirname(HERE)]
import crt_backtest as cb
from features import add_features, stats

csv, tfs = sys.argv[1], sys.argv[2].split(",")
base = cb.load(csv, "UTC")
out = []
for tf in tfs:
    m = cb.TIMEFRAMES[tf]
    tr = pd.DataFrame(cb.simulate(base, cb.find_signals(cb.build_candles(base, m), tf), 0.75))
    out.append(add_features(tr, base, m))
t = pd.concat(out)
t["half"] = t.entry_time.dt.year.astype(str)
filters = {
    "baseline": t.R == t.R,
    "bias aligned": t.aligned,
    "bias AGAINST": ~t.aligned,
    "key-level sweep": t.key_sweep,
    "fresh key sweep": t.fresh_sweep,
    "no key sweep": ~t.key_sweep,
    "bias + key sweep": t.aligned & t.key_sweep,
    "bias + fresh sweep": t.aligned & t.fresh_sweep,
    "RR >= 1": t.rr >= 1,
    "bias + RR>=1": t.aligned & (t.rr >= 1),
    "longs only": t.dir == "long",
}
pd.set_option("display.width", 200)
for tf in tfs:
    print(f"\n===== {tf} CRT =====")
    rows = {}
    for name, f in filters.items():
        s = t[(t.tf == tf) & f]
        r = stats(s)
        for y in sorted(t.half.unique()):
            r[f"totR {y}"] = round(s[s.half == y].R.sum(), 1)
            r[f"n {y}"] = (s.half == y).sum()
        rows[name] = r
    print(pd.DataFrame(rows).T.to_string())
t.to_csv(sys.argv[3], index=False)
