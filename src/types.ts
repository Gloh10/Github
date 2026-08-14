export type Direction = 'long' | 'short'
export type Outcome = 'win' | 'loss' | 'breakeven'

export interface AIAnalysisResult {
  text: string
  model: string
  generatedAt: number
}

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
  personalNotes: string
  screenshotIds: string[]
  aiAnalysis?: AIAnalysisResult | null
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
