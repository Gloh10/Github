import { useMemo, useState } from 'react'
import type { Outcome, Trade } from '../types'
import { TradeCard } from './TradeCard'

const outcomeFilters: { label: string; value: Outcome | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Wins', value: 'win' },
  { label: 'Losses', value: 'loss' },
  { label: 'Breakeven', value: 'breakeven' },
]

export function TradeList({ trades, onSelect }: { trades: Trade[]; onSelect: (trade: Trade) => void }) {
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<Outcome | 'all'>('all')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return trades.filter((t) => {
      if (outcome !== 'all' && t.outcome !== outcome) return false
      if (!q) return true
      return (
        t.symbol.toLowerCase().includes(q) ||
        t.mistakes.some((m) => m.toLowerCase().includes(q)) ||
        t.confluences.some((c) => c.toLowerCase().includes(q))
      )
    })
  }, [trades, search, outcome])

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol, mistake, confluence…"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none sm:max-w-xs"
        />
        <div className="flex gap-1.5">
          {outcomeFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => setOutcome(f.value)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                outcome === f.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 py-16 text-center text-sm text-slate-500">
          {trades.length === 0 ? 'No trades logged yet. Add your first trade to get started.' : 'No trades match your filters.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((trade) => (
            <TradeCard key={trade.id} trade={trade} onClick={() => onSelect(trade)} />
          ))}
        </div>
      )}
    </div>
  )
}
