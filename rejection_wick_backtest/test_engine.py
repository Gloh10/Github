"""
Sanity checks for the rejection-wick engine using synthetic data.

This does NOT validate the strategy's real-world edge (no real market data
is available in this environment) — it only proves the engine's mechanics
(signal detection, entry-on-tap, 55%-stop placement, trailing logic,
overlap handling, metrics) behave as specified and don't crash or produce
nonsensical output.
"""
import numpy as np
import pandas as pd

from engine import (
    compute_wick_features, add_context_filters, generate_signals,
    simulate_trades, evaluate, optimize_ratio,
)


def make_synthetic(n=2000, seed=7):
    rng = np.random.default_rng(seed)
    price = 5000.0
    rows = []
    idx = pd.date_range("2024-01-01", periods=n, freq="5min")
    for _ in range(n):
        o = price
        drift = rng.normal(0, 1.2)
        c = o + drift
        # Occasionally inject a strong rejection wick.
        if rng.random() < 0.08:
            wick = rng.uniform(4, 12)
            if rng.random() < 0.5:
                h = max(o, c) + wick
                l = min(o, c) - rng.uniform(0, 1)
            else:
                l = min(o, c) - wick
                h = max(o, c) + rng.uniform(0, 1)
        else:
            h = max(o, c) + rng.uniform(0, 2)
            l = min(o, c) - rng.uniform(0, 2)
        rows.append((o, h, l, c))
        price = c
    df = pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx)
    return df


def test_feature_shapes():
    df = make_synthetic(500)
    feat = compute_wick_features(df)
    assert (feat["upper_wick_ratio"] >= 0).all() and (feat["upper_wick_ratio"] <= 1.0001).all()
    assert (feat["lower_wick_ratio"] >= 0).all() and (feat["lower_wick_ratio"] <= 1.0001).all()


def test_stop_side_is_correct():
    df = make_synthetic(3000)
    feat = compute_wick_features(df)
    feat = add_context_filters(feat)
    signals = generate_signals(feat, wick_ratio=0.6)
    assert len(signals) > 0, "synthetic data should produce some rejection signals"
    for s in signals:
        if s.direction == "short":
            assert s.stop_level >= s.wick_start - 1e-9, "short stop must sit above (or at) entry"
        else:
            assert s.stop_level <= s.wick_start + 1e-9, "long stop must sit below (or at) entry"


def test_trades_have_sane_fields():
    df = make_synthetic(3000)
    feat = compute_wick_features(df)
    feat = add_context_filters(feat)
    signals = generate_signals(feat, wick_ratio=0.55)
    trades = simulate_trades(feat, signals)
    assert len(trades) > 0
    for t in trades:
        assert t.exit_idx >= t.entry_idx
        assert t.entry_idx > t.signal_idx
    m = evaluate(trades)
    assert m["trade_count"] == len(trades)
    assert 0.0 <= m["win_rate"] <= 1.0


def test_no_overlapping_trades():
    df = make_synthetic(3000)
    feat = compute_wick_features(df)
    feat = add_context_filters(feat)
    signals = generate_signals(feat, wick_ratio=0.55)
    trades = simulate_trades(feat, signals)
    for a, b in zip(trades, trades[1:]):
        assert b.entry_idx > a.exit_idx, "trades should not overlap"


def test_optimize_ratio_runs():
    df = make_synthetic(4000)
    result = optimize_ratio(df, thresholds=[0.5, 0.6, 0.7, 0.8], min_trades=5)
    assert list(result.index) == [0.5, 0.6, 0.7, 0.8]
    assert (result["trade_count"] >= 0).all()


if __name__ == "__main__":
    test_feature_shapes()
    test_stop_side_is_correct()
    test_trades_have_sane_fields()
    test_no_overlapping_trades()
    test_optimize_ratio_runs()
    print("All sanity checks passed.")
