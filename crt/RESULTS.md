# CRT NY AM backtest results — NQ1! (CME)

Data: TradingView, CME_MINI:NQ1!, full 23h session.
- 15m bars: Jul 1 – Oct 14, 2026 (6,927 bars) — used for 30m/1H/4H with fine-grained exits
- 1h bars: Jan 1, 2025 – Oct 14, 2026 (10,535 bars) — longer sample for 1H/4H

Rules: C2 sweeps C1 high/low and closes back inside C1; C2 closes 09:30 < t <= 12:00 ET;
entry at C2 close, stop C2 wick, target opposite side of C1, flat at 16:00 ET.
Costs: 0.75 pt per round trip. If a bar hits stop and target, stop is assumed first.
1H results on 1h bars matched 15m bars exactly over the overlap (61/61 trades), so hourly exits are reliable.

## By timeframe

| CRT TF | Sample | Trades | Win % | Avg R | Total R | PF | Max DD (R) |
|---|---|---|---|---|---|---|---|
| 30m | Jul–Oct 2026 | 94 | 55 | +0.27 | +25.6 | 1.62 | 6.0 |
| 1H | Jul–Oct 2026 | 61 | 56 | +0.18 | +10.9 | 1.45 | 5.8 |
| 4H | Jul–Oct 2026 | 10 | 60 | +0.29 | +2.9 | 2.74 | 1.6 |
| 1H | Jan 2025–Oct 2026 | 372 | 50 | +0.04 | +13.3 | 1.07 | 16.4 |
| 4H | Jan 2025–Oct 2026 | 90 | 56 | +0.01 | +0.7 | 1.02 | 6.9 |

30m looks best recently, but 3.5 months is not enough to trust (most of it came from August).
Over 1.8 years, plain 1H and 4H CRTs are roughly break-even after costs.

## Filters (1H CRT, Jan 2025–Oct 2026)

| Filter | Trades | Avg R | Total R | PF | 2025 R | 2026 R |
|---|---|---|---|---|---|---|
| Baseline | 372 | +0.04 | +13.3 | 1.07 | +8.2 | +5.2 |
| **C2 swept a key level** (PDH/PDL, PWH/PWL, Asia, London) | 165 | **+0.14** | +23.1 | 1.39 | +14.8 | +8.3 |
| C2 swept no key level | 207 | −0.05 | −9.8 | 0.92 | −6.7 | −3.1 |
| Key sweep, longs | 90 | +0.24 | +21.6 | 1.94 | | |
| Key sweep, shorts | 75 | +0.02 | +1.5 | 1.04 | | |
| 1H pivot bias aligned (indicator's bias) | 137 | +0.10 | +13.9 | 1.23 | +12.8 | +1.0 |

- Key-level sweep is the best filter found, but it is not consistent: by half-year it was
  +14.9, −0.1, +10.3, −2.0 R. Treat it as a mild edge, not a proven one.
- Much of the edge is on the long side during a strong NQ uptrend.
- The indicator's 1H pivot bias helped in 2025 but not in 2026.

## Indicator's standalone sweep + reclaim signal

A single bar in 09:30–11:30 wicking through a fresh key level and closing back:
lost money with every target tested (1R, 2R, opposite liquidity), in both datasets and both years
(e.g. 1h bars, 2R target: 188 trades, −0.21R avg). It is now off by default in the indicator.

Reproduce: `python analysis/run_filters.py NQ1_1h.csv 1H,4H out.csv` and
`python analysis/sweep_signal.py NQ1_15m.csv`.
