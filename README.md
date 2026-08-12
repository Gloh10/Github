# Trading Journal

A local-first trading journal: log each trade with a chart screenshot, the date/time, why you took it (confluences), what you did right/wrong, and how to improve — then get warned automatically when you repeat the same mistake in consecutive trades.

Everything is stored in your browser's IndexedDB. There's no backend and no account — your trades and screenshots never leave your machine.

## Features

- **Screenshots** — paste (Ctrl/Cmd+V), drag-and-drop, or upload chart screenshots per trade, stored as image blobs in IndexedDB.
- **Trade log** — date, time, symbol, direction, outcome, P&L, R:R, confluences, mistakes, what went right/wrong, and improvement notes.
- **Mistake streak detection** — if the same mistake tag (e.g. "FOMO entry") appears in 2+ consecutive trades, a banner flags it on both the Journal and Dashboard views.
- **Recent-frequency insights** — mistakes that show up often within your last 5 trades (even if not strictly back-to-back) get a lighter heads-up.
- **Dashboard** — win rate, total P&L, most common mistakes, and win rate by confluence, so you can see which setups actually work for you.

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
