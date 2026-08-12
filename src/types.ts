export type Direction = 'long' | 'short'
export type Outcome = 'win' | 'loss' | 'breakeven'

export interface Trade {
  id: string
  date: string // YYYY-MM-DD
  time: string // HH:MM, 24h
  symbol: string
  direction: Direction
  outcome: Outcome
  pnl: number | null
  riskReward: number | null
  confluences: string[]
  mistakes: string[]
  whatWentRight: string
  whatWentWrong: string
  improvementNotes: string
  screenshotIds: string[]
  createdAt: number
  updatedAt: number
}

export type TradeInput = Omit<Trade, 'id' | 'createdAt' | 'updatedAt' | 'screenshotIds'>

export interface Screenshot {
  id: string
  tradeId: string
  blob: Blob
  name: string
  type: string
  createdAt: number
}

export const DEFAULT_CONFLUENCES = [
  'Support/Resistance',
  'Trendline break',
  'Trend continuation',
  'Reversal pattern',
  'Volume spike',
  'Moving average bounce',
  'Fibonacci level',
  'Breakout',
  'News catalyst',
  'Higher timeframe alignment',
]

export const DEFAULT_MISTAKES = [
  'FOMO entry',
  'No stop loss',
  'Moved stop loss',
  'Oversized position',
  'Entered too early',
  'Entered too late',
  'Ignored plan',
  'Revenge trading',
  'Overtraded',
  'Exited too early',
  'Held too long',
  'Chased price',
]
