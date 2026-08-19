# Trading Journal

A local-first trading journal: log each trade with a chart screenshot, the date/time, and why you took it (confluences) — the app generates the "what went right / what went wrong / how to improve" analysis for you, then warns you when you repeat the same mistake in consecutive trades.

Everything is stored in your browser's IndexedDB. There's no backend and no account — your trades and screenshots never leave your machine, except for the optional AI screenshot analysis (see below), which is opt-in and uses your own API key.

## Features

- **Screenshots** — paste (Ctrl/Cmd+V), drag-and-drop, or upload chart screenshots per trade, stored as image blobs in IndexedDB.
- **Trade log** — date, time, symbol, direction, outcome, P&L, R:R, confluences, mistakes, and a free-text personal notes field for anything else worth remembering.
- **Auto-generated analysis** — instead of typing your own notes, tag the confluences and mistakes that applied, and the app writes the "what went right / what went wrong / how to improve" breakdown for you, drawn from a knowledge base of specific trader concepts (Powell's rejection blocks, PB Trades' draw-on-liquidity and process discipline, Dodgy Trade's engineered liquidity and Judas swing model), each line attributed to its source.
- **AI screenshot analysis (optional)** — click "Analyze with AI" on a trade with screenshot(s) to have Claude actually look at the chart(s) and explain why the trade likely won or lost. If you've uploaded multiple screenshots (e.g. a higher timeframe for context plus a 1-minute chart for the entry), all of them are sent together so Claude can connect entry timing across timeframes. Each trade also has an optional "Questions for AI analysis" box — ask anything specific ("was my entry too early? should I have waited for the 1min FVG to fill?") and it gets answered directly, referencing what's actually visible in the screenshot(s). Requires your own Anthropic API key, entered in Settings and stored only in your browser — the screenshots, trade tags, and your questions are sent to Anthropic's API when you use this, nothing else.
- **Mistake streak detection** — if the same mistake tag (e.g. "FOMO entry") appears in 2+ consecutive trades, a banner flags it on both the Journal and Dashboard views. The Dashboard also lists every mistake tag ranked by its current streak, highest first.
- **Recent-frequency insights** — mistakes that show up often within your last 5 trades (even if not strictly back-to-back) get a lighter heads-up.
- **Recurring notes themes** — if a word or short phrase shows up in your personal notes across 2 or more trades (e.g. "felt rushed", "confirmation"), you get notified on the Journal view, with a full ranked list on the Dashboard. False positives can be dismissed with the ✕ on either surface, and stay dismissed.
- **Notes log** — a dedicated tab listing every trade's personal notes in one place, newest first, with the date and symbol, click through to the full trade.
- **Calendar** — a month view showing trade count and win/loss for each day you traded, color-coded by outcome; click a day to see that day's trades. Comes with a day-of-week breakdown (win rate and volume per weekday) that calls out your best and worst performing days, plus a similar-looking-chart-days detector: a local perceptual hash (not AI, no API calls) flags screenshots from different days that look visually alike, so you can spot recurring setups. It's a coarse visual fingerprint, not real pattern recognition — treat matches as a nudge to go look, not proof.
- **Dashboard** — win rate, total P&L, most common mistakes, mistake streaks ranked highest-to-lowest, recurring note themes, and win rate by confluence, so you can see which setups actually work for you.

## Getting started

```bash
npm install
npm run dev
```

Open the printed local URL. Click **+ New Trade** to log your first trade.

To build a static production bundle (deployable anywhere, e.g. GitHub Pages, Netlify, Vercel, or just opened from disk):

```bash
npm run build
npm run preview   # serve the built dist/ folder locally
```

## Tech

React + TypeScript + Vite, styled with Tailwind CSS v4. Data and screenshots persist in the browser via IndexedDB (through the `idb` helper library) — no server, no database to run.

## Notes on data

- Data is per-browser-profile. Clearing site data/cookies for this app will delete your journal.
- There's no built-in export/sync yet — if you want to move data between devices or back it up, that's the natural next feature to add.
