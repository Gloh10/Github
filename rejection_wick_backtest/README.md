# Rejection-Wick Backtest

Backtests a rejection-wick price-action strategy on futures across 1hr / 15min /
5min / 3min bars, and grid-searches the wick-ratio threshold to find the one
with the best win rate / expectancy.

## Strategy, as implemented

1. **Rejection candle**: a candle whose upper wick (bearish) or lower wick
   (bullish) is at least `wick_ratio` of the candle's total high-low range.
   The dominant wick determines direction — upper wick → short setup, lower
   wick → long setup.
2. **Optional context filters**:
   - `--sweep`: the wick must poke past the prior 20-bar high/low before
     reversing (a liquidity sweep).
   - `--trend`: the setup must align with an EMA(50) trend filter (short
     only in a downtrend, long only in an uptrend).
3. **Entry**: wait for a later candle (within 20 bars) whose range trades
   back into the rejection candle's wick — i.e. touches the level where the
   wick begins (the top of the body for a bearish wick, the bottom of the
   body for a bullish wick). Entry fills at that level.
4. **Initial stop-loss**: 55% of the way through the *rejection candle's*
   total range, measured from the side opposite the wick (so it sits inside
   the wick, beyond the entry level — this only makes geometric sense for
   `wick_ratio > 0.45`, which the search range respects).
5. **Trailing stop**: once the trade is favorable by `trail_trigger_pts`
   (default 5 points), a trailing stop activates and trails
   `trail_distance_pts` (default 5 points) behind the best price reached,
   ratcheting only in the trade's favor, until price tags it.
6. Trades don't overlap — a new signal is skipped while a prior trade from
   an earlier signal is still open.

## Assumptions made where the spec was ambiguous — flag if wrong

- "Taps the beginning of the rejection wick" = price trades through the
  rejection candle's body edge on the wick side (not the wick tip / not the
  candle's high or low).
- "Stop-loss at 55% of the candle" = 55% of the **rejection candle's**
  range (not the entry/trigger candle's range).
- Trail distance defaults to the same 5 points as the trigger — the spec
  didn't give a separate trail distance. Change with `--trail-distance`.
- "Same trend as the market is moving" implemented as EMA(50) filter
  (`--trend`); "liquidity sweep" implemented as a break of the prior 20-bar
  high/low (`--sweep`). Both are opt-in flags, not defaults, since the spec
  said "preferably," not "always."
- No take-profit target — exit is purely stop / trailing-stop driven
  ("until tapped out"), matching the spec.

## Data — this sandbox can't fetch it

This session's network policy blocks Yahoo Finance, Stooq, Databento, and
CME (all return 403 at the proxy) — there's no way to pull real futures bars
from here. The engine is fully built and passes sanity checks on synthetic
data (`python3 test_engine.py`), but the results above are **not real
signal**, just proof the mechanics work.

To get a real backtest, supply historical OHLCV bars (ideally 1-minute, so
3min/5min/15min/1h can all be resampled from one file) as CSV with columns
`datetime,open,high,low,close[,volume]`. Sources that typically export this:
TradingView (Export chart data), NinjaTrader, Databento, IBKR/TWS, Sierra
Chart. Then run:

```bash
python3 run_backtest.py --csv your_1min_data.csv \
    --timeframes 1min:3min,1min:5min,1min:15min,1min:1h \
    --thresholds 0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9 \
    --sweep --trend
```

Or, if you already have separate files per timeframe:

```bash
python3 run_backtest.py --csv-map 1h=es_1h.csv,15min=es_15m.csv,5min=es_5m.csv,3min=es_3m.csv
```

## Files

- `engine.py` — signal detection, trade simulation, metrics, ratio optimizer.
- `data.py` — CSV loading + resampling.
- `run_backtest.py` — CLI runner.
- `test_engine.py` — synthetic-data sanity checks (`python3 test_engine.py`).
