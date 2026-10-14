# CRT NY AM backtest (NQ)

Candle Range Theory on 30m, 1H and 4H, filtered to the NY AM session.

**Rules.** C1 is the range candle. C2 sweeps C1's high (or low) and closes back inside C1. The trade enters at C2's close, the stop goes at C2's wick and the target is the opposite side of C1. C2 must close between 09:30 (exclusive) and 12:00 ET (inclusive). Anything still open is closed at 16:00 ET. CRT candles follow the CME clock, so the 4H candles open at 18, 22, 02, 06, 10 and 14 ET. That makes the only 4H setup in the NY AM window the 06:00–10:00 candle sweeping the 02:00–06:00 candle.

**Key sweep filter** (strategy default: on). A trade is only taken if C2 also sweeps a key level and closes back past it. The key levels are PDH/PDL, PWH/PWL, Asia H/L (20:00–00:00 ET) and London H/L (02:00–05:00 ET). Set it to "Only NO key sweep" to see the trades the filter removes. Results are in `RESULTS.md`.

## TradingView
1. Open `NQ1!` on a **1m or 5m** chart.
2. Pine Editor → paste `crt_ny_am_strategy.pine` → Add to chart.
3. Switch the **CRT timeframe** input between 30 / 60 / 240 and compare the Strategy Tester and the stats table (win rate, target and stop hits, avg R, total R, profit factor in R).

How far back you can test depends on your TradingView plan's intraday history. Deep Backtesting (Premium) gives the most.

## Python (all timeframes at once, with breakdowns)
Export NQ1! 1m or 5m chart data from TradingView (chart menu → Export chart data, with Unix-timestamp time). Then run:

```
python crt_backtest.py NQ1_5m.csv --out trades.csv
```

The output is broken down by timeframe, direction, C2 close time and year. When a bar touches both the stop and the target, the stop is assumed to be hit first, so results are conservative. R figures exclude commissions.
