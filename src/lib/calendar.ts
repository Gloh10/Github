import type { Trade } from '../types'

export interface DaySummary {
  date: string // YYYY-MM-DD
  trades: Trade[]
  wins: number
  losses: number
  breakeven: number
  pnl: number
}

export function getTradesByDate(trades: Trade[]): Map<string, Trade[]> {
  const map = new Map<string, Trade[]>()
  for (const t of trades) {
    const list = map.get(t.date) ?? []
    list.push(t)
    map.set(t.date, list)
  }
  return map
}

export function summarizeDay(date: string, dayTrades: Trade[]): DaySummary {
  const wins = dayTrades.filter((t) => t.outcome === 'win').length
  const losses = dayTrades.filter((t) => t.outcome === 'loss').length
  const breakeven = dayTrades.length - wins - losses
  const pnl = dayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  return { date, trades: dayTrades, wins, losses, breakeven, pnl }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface DayOfWeekStat {
  day: string
  dayIndex: number
  trades: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  totalPnl: number
}

/** Aggregate performance by day of week (Sunday-Saturday), for trades with at least one win/loss recorded. */
export function getDayOfWeekStats(trades: Trade[]): DayOfWeekStat[] {
  const buckets: Trade[][] = Array.from({ length: 7 }, () => [])
  for (const t of trades) {
    const parsed = new Date(`${t.date}T00:00:00`)
    if (Number.isNaN(parsed.getTime())) continue
    buckets[parsed.getDay()].push(t)
  }
  return buckets.map((list, i) => {
    const wins = list.filter((t) => t.outcome === 'win').length
    const losses = list.filter((t) => t.outcome === 'loss').length
    const breakeven = list.length - wins - losses
    const winRate = wins + losses > 0 ? wins / (wins + losses) : 0
    const totalPnl = list.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
    return { day: DAY_NAMES[i], dayIndex: i, trades: list.length, wins, losses, breakeven, winRate, totalPnl }
  })
}
