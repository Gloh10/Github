import type { Trade } from '../types'

export type TraderSource = 'powell' | 'pbtrades' | 'dodgy' | 'general'

export const TRADER_LABELS: Record<TraderSource, string> = {
  powell: 'Powell',
  pbtrades: 'PB Trades',
  dodgy: 'Dodgy Trade',
  general: 'General',
}

interface ConceptEntry {
  tag: string
  source: TraderSource
  rightText?: string
  wrongText?: string
  improveText?: string
}

const CONFLUENCE_CONCEPTS: ConceptEntry[] = [
  {
    tag: 'Rejection block (liquidity + level)',
    source: 'powell',
    rightText:
      'You took a high-probability rejection block — the wick swept resting liquidity and tapped a level (order block, FVG, key open, or fib) at the same spot, then closed in your direction. Powell rates this the strongest version of the setup, over a bare wick-and-close.',
  },
  {
    tag: 'Draw on liquidity identified',
    source: 'pbtrades',
    rightText:
      "You identified your higher-timeframe draw on liquidity before looking for an entry. PB Trades: entries are just the vehicle that gets you to your draw on liquidity — establishing it first is what gives a trade a real narrative instead of a coin flip.",
  },
  {
    tag: 'Inversion FVG (IFVG)',
    source: 'pbtrades',
    rightText:
      "You entered off an inversion fair value gap — a fair value gap that got fully violated, flipping order flow. PB Trades builds their entire entry model around this: 'once all fair value gaps get inverse, there's nothing left to disrespect the trade.'",
  },
  {
    tag: 'Daily bias written pre-session',
    source: 'pbtrades',
    rightText:
      'You wrote a daily bias before the session with A+ scenarios for both directions, and only executed once one played out. PB Trades credits this for keeping decisions reactive instead of predictive, and for filtering out lower-timeframe noise.',
  },
  {
    tag: 'Engineered liquidity (equal highs/lows)',
    source: 'dodgy',
    rightText:
      "You targeted engineered liquidity — a session extreme reinforced by relative equal highs/lows, not just a random level. Dodgy Trade: in current conditions, plain session highs/lows aren't reliable draws anymore; the reinforced, multi-touch levels are where retail stops actually cluster.",
  },
  {
    tag: 'Trendline liquidity',
    source: 'dodgy',
    rightText:
      'You targeted trendline liquidity — stops built up under/over a drawn trendline from repeated swing touches. Dodgy Trade calls this his #1 draw on liquidity right now, since more retail traders trade trendlines today, which stacks bigger clusters of stops there.',
  },
  {
    tag: 'Judas swing (9:30 open)',
    source: 'dodgy',
    rightText:
      'You caught a Judas swing at the open — a false move sweeping one side right at 9:30 before reversing with an IFVG in the real direction. This has become a core part of Dodgy Trade\'s model, shifting most of his trading into the 9:30–10:00 window.',
  },
  {
    tag: 'Momentum candle entry',
    source: 'dodgy',
    rightText:
      "You entered off a real momentum candle (a decisive 'death' or 'birth' candle) rather than a choppy close. Dodgy Trade has moved away from entries in indecisive chop — momentum on the entry candle is now one of his filters.",
  },
  {
    tag: 'Backtested setup',
    source: 'pbtrades',
    rightText:
      "This setup matches a pattern you've backtested. PB Trades: confidence doesn't come from taking more live trades, it comes from seeing your edge play out repeatedly in backtesting first — that's what removes hesitation.",
  },
]

const MISTAKE_CONCEPTS: ConceptEntry[] = [
  {
    tag: 'Rejection block without liquidity/level',
    source: 'powell',
    wrongText:
      "You traded a bare rejection block — a wick with a confirming close, but no liquidity sweep or level tapped underneath it. Powell says this 'good enough' version happens constantly and fails a lot; it's not the high-probability version.",
    improveText:
      'Before taking a rejection block, check for a liquidity sweep AND a level (order block, FVG, key open, fib) at the same spot. If only one is present, treat it as lower quality and size down or skip.',
  },
  {
    tag: 'No draw on liquidity / narrative',
    source: 'pbtrades',
    wrongText:
      "You entered without first establishing a higher-timeframe draw on liquidity. PB Trades: 'most traders lose not because their entry was bad, but because they didn't know where price was heading in the first place' — without a target, an entry model is just a coin flip.",
    improveText:
      'Before scanning for entries, mark your higher-timeframe draw on liquidity first. Reverse-engineer the entry from that target, not the other way around.',
  },
  {
    tag: 'Chased lower-timeframe SMT/noise',
    source: 'pbtrades',
    wrongText:
      "You reacted to a lower-timeframe signal that wasn't sitting at your higher-timeframe draw on liquidity. PB Trades calls this the most common way ICT-style traders talk themselves into analysis paralysis — noise that isn't at your target doesn't count as confirmation.",
    improveText:
      "Only weight SMTs/confirmations that occur at your higher-timeframe PDA or target. If it's not there, it's noise — ignore it.",
  },
  {
    tag: 'Overcomplicated confluences',
    source: 'pbtrades',
    wrongText:
      "You stacked more confluences onto this trade than your model actually calls for. PB Trades: 'a good strategy is a simple strategy... if you try to add too much, you'll sit there waiting for every box to check and miss the setup 90% of the time.'",
    improveText:
      "Strip the model back down to the 2-3 things it's actually built on. If you can't explain the setup simply, it's grown past what you can execute with confidence.",
  },
  {
    tag: 'No daily bias written',
    source: 'pbtrades',
    wrongText:
      "You didn't write a bias before the session. Without one, PB Trades warns you're liable to read every green candle as 'up' and every red candle as 'down' — reacting to noise instead of a narrative.",
    improveText:
      'Write your bias and A+ scenarios (both directions) before the session opens, and only execute once one of them actually plays out.',
  },
  {
    tag: 'Forced a trade (no clear direction)',
    source: 'pbtrades',
    wrongText:
      "You took a trade without clear direction. PB Trades: knowing when NOT to trade is as important as knowing when to trade — 'if a trade isn't obvious, you skip it.'",
    improveText:
      "If you wouldn't call it a mistake to skip the setup, don't force it. A day with no trades preserves capital for the next A+ setup — Mark Douglas's 'best trades are the ones you don't take.'",
  },
  {
    tag: 'Skipped journaling/backtesting',
    source: 'pbtrades',
    wrongText:
      "This trade wasn't backed by regular journaling or backtesting on this setup. PB Trades: 'if you're not journaling, you're trading blind, repeating mistakes without realizing it' — and backtesting builds real conviction, not more live reps.",
    improveText:
      'Backtest this specific session/instrument on a regular cadence (PB Trades does ~1hr/day, one week of data at a time), and journal every trade — bias, execution, emotions, screenshot.',
  },
  {
    tag: 'Traded outside core session/pair/model',
    source: 'pbtrades',
    wrongText:
      "You traded outside your core session, instrument, or entry model. PB Trades: mixing sessions/pairs/models means you're 'mixing in a bunch of different probabilities' and will never build a real, trackable edge.",
    improveText:
      "Pick one model, one instrument, one session, and stay in that lane until you've actually built statistical confidence in it.",
  },
  {
    tag: 'Entered on choppy close (no momentum)',
    source: 'dodgy',
    wrongText:
      "You entered on a choppy, indecisive close rather than a real momentum candle. Dodgy Trade has moved away from this specifically because it's where he sees people 'getting wrecked' in current conditions.",
    improveText:
      "Wait for a decisive momentum candle (what Dodgy calls a 'death' or 'birth' candle) before entering. If price is just chopping sideways, that's not it yet.",
  },
  {
    tag: 'Targeted already-run liquidity',
    source: 'dodgy',
    wrongText:
      "You targeted a level whose liquidity had already been swept. Dodgy Trade: once the stops behind a level are gone, 'there's no more stop-losses here anymore' — there's nothing left to draw price there.",
    improveText:
      'Before marking a target, check whether that liquidity has already been run by a prior wick. If it has, find the next untouched pool instead.',
  },
  {
    tag: 'Entered without inversion confirmation',
    source: 'dodgy',
    wrongText:
      "You entered before the inversion fair value gap actually confirmed. Dodgy Trade is explicit about this: if the setup looked promising but the inversion never formed, 'I'm not going to take the trade.'",
    improveText:
      "Wait for the IFVG to actually complete (the opposing FVG fully broken) before entering — don't front-run the confirmation because the setup 'looks' like it's forming.",
  },
  {
    tag: 'Skipped extra confluence (OB/CISD)',
    source: 'dodgy',
    wrongText:
      "You took the IFVG alone without the extra confluence Dodgy Trade now requires. In his current model, he no longer takes a bare inversion — he wants an order block bounce or a CISD stacked on top, because of how much worse price action has gotten.",
    improveText:
      'Don’t settle for the base IFVG in current conditions — confirm an order block or CISD is also present at the same spot before entering.',
  },
]

export const CONFLUENCE_TAGS = CONFLUENCE_CONCEPTS.map((c) => c.tag)
export const MISTAKE_TAGS = MISTAKE_CONCEPTS.map((c) => c.tag)

export interface AnalysisLine {
  text: string
  source: TraderSource
}

export interface TradeAnalysis {
  whatWentRight: AnalysisLine[]
  whatWentWrong: AnalysisLine[]
  improvementTips: AnalysisLine[]
}

export function generateAnalysis(trade: Pick<Trade, 'confluences' | 'mistakes' | 'outcome'>): TradeAnalysis {
  const whatWentRight: AnalysisLine[] = []
  const whatWentWrong: AnalysisLine[] = []
  const improvementTips: AnalysisLine[] = []

  for (const tag of trade.confluences) {
    const concept = CONFLUENCE_CONCEPTS.find((c) => c.tag === tag)
    if (concept?.rightText) whatWentRight.push({ text: concept.rightText, source: concept.source })
  }

  for (const tag of trade.mistakes) {
    const concept = MISTAKE_CONCEPTS.find((c) => c.tag === tag)
    if (concept?.wrongText) whatWentWrong.push({ text: concept.wrongText, source: concept.source })
    if (concept?.improveText) improvementTips.push({ text: concept.improveText, source: concept.source })
  }

  if (trade.confluences.length === 0) {
    whatWentRight.push({
      text: 'No confluences were tagged on this trade, so there’s nothing here yet to reinforce as good process.',
      source: 'general',
    })
  }

  if (trade.mistakes.length === 0 && trade.outcome === 'loss' && trade.confluences.length > 0) {
    whatWentWrong.push({
      text: "No process mistakes were tagged — this matches your model but still lost. PB Trades and Mark Douglas both make the same point: even A+ setups lose sometimes. That's expected variance, not a flaw in the model.",
      source: 'general',
    })
  }

  if (trade.mistakes.length > 0 && trade.outcome !== 'loss') {
    improvementTips.unshift({
      text: `This trade won despite ${trade.mistakes.length} tagged mistake${trade.mistakes.length > 1 ? 's' : ''} — a good result doesn't validate a bad process. That's "resulting": judging a decision by its outcome instead of its quality. Watch for this pattern; it's how bad habits get reinforced.`,
      source: 'general',
    })
  }

  return { whatWentRight, whatWentWrong, improvementTips }
}
