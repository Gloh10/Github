import type { Trade } from '../types'

function chronological(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const cmp = `${a.date}T${a.time || '00:00'}`.localeCompare(`${b.date}T${b.time || '00:00'}`)
    return cmp !== 0 ? cmp : a.createdAt - b.createdAt
  })
}

export interface MistakeStreak {
  mistake: string
  streak: number
  tradeIds: string[] // most recent first
}

/** Mistakes repeated in the N most recent consecutive trades, walking backward from today. */
export function getActiveMistakeStreaks(trades: Trade[], minStreak = 2): MistakeStreak[] {
  const chrono = chronological(trades)
  const allMistakes = new Set<string>()
  chrono.forEach((t) => t.mistakes.forEach((m) => allMistakes.add(m)))

  const results: MistakeStreak[] = []
  for (const mistake of allMistakes) {
    let streak = 0
    const ids: string[] = []
    for (let i = chrono.length - 1; i >= 0; i--) {
      if (chrono[i].mistakes.includes(mistake)) {
        streak++
        ids.push(chrono[i].id)
      } else {
        break
      }
    }
    if (streak >= minStreak) {
      results.push({ mistake, streak, tradeIds: ids })
    }
  }
  return results.sort((a, b) => b.streak - a.streak)
}

export interface MistakeFrequency {
  mistake: string
  count: number
  windowSize: number
}

/** Mistakes that showed up often within the last N trades, even if not strictly consecutive. */
export function getRecentMistakeFrequency(trades: Trade[], windowSize = 5, minCount = 2): MistakeFrequency[] {
  const chrono = chronological(trades).slice(-windowSize)
  const counts = new Map<string, number>()
  chrono.forEach((t) => t.mistakes.forEach((m) => counts.set(m, (counts.get(m) ?? 0) + 1)))
  return [...counts.entries()]
    .map(([mistake, count]) => ({ mistake, count, windowSize: chrono.length }))
    .filter((f) => f.count >= minCount)
    .sort((a, b) => b.count - a.count)
}

export interface ConfluenceStat {
  name: string
  count: number
  wins: number
  winRate: number
}

export interface JournalStats {
  total: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  totalPnl: number
  topMistakes: { name: string; count: number }[]
  topConfluences: ConfluenceStat[]
}

export function getStats(trades: Trade[]): JournalStats {
  const total = trades.length
  const wins = trades.filter((t) => t.outcome === 'win').length
  const losses = trades.filter((t) => t.outcome === 'loss').length
  const breakeven = total - wins - losses
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)

  const mistakeCounts = new Map<string, number>()
  const confluenceCounts = new Map<string, number>()
  const confluenceWinCounts = new Map<string, number>()

  trades.forEach((t) => {
    t.mistakes.forEach((m) => mistakeCounts.set(m, (mistakeCounts.get(m) ?? 0) + 1))
    t.confluences.forEach((c) => {
      confluenceCounts.set(c, (confluenceCounts.get(c) ?? 0) + 1)
      if (t.outcome === 'win') confluenceWinCounts.set(c, (confluenceWinCounts.get(c) ?? 0) + 1)
    })
  })

  const topMistakes = [...mistakeCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)

  const topConfluences = [...confluenceCounts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      wins: confluenceWinCounts.get(name) ?? 0,
      winRate: count > 0 ? (confluenceWinCounts.get(name) ?? 0) / count : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)

  return { total, wins, losses, breakeven, winRate, totalPnl, topMistakes, topConfluences }
}
