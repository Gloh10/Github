import type { Trade } from '../types'
import { getDayOfWeekStats } from '../lib/calendar'

export function DayOfWeekInsights({ trades }: { trades: Trade[] }) {
  const stats = getDayOfWeekStats(trades).filter((s) => s.trades > 0)
  const withDecisions = stats.filter((s) => s.wins + s.losses > 0)

  if (stats.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-200">Performance by day of week</h3>
        <p className="text-sm text-slate-500">No trades logged yet.</p>
      </div>
    )
  }

  const best = [...withDecisions].sort((a, b) => b.winRate - a.winRate)[0]
  const worst = [...withDecisions].sort((a, b) => a.winRate - b.winRate)[0]
  const maxTrades = Math.max(1, ...stats.map((s) => s.trades))

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Performance by day of week</h3>

      {best && worst && best.day !== worst.day && (
        <div className="mb-4 space-y-2">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            Best day: <span className="font-semibold">{best.day}</span> — {Math.round(best.winRate * 100)}% win rate
            over {best.trades} trade{best.trades === 1 ? '' : 's'}
          </div>
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            Worst day: <span className="font-semibold">{worst.day}</span> — {Math.round(worst.winRate * 100)}% win
            rate over {worst.trades} trade{worst.trades === 1 ? '' : 's'}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {stats.map((s) => (
          <div key={s.day}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-slate-300">{s.day}</span>
              <span className="text-slate-500">
                {s.trades} trade{s.trades === 1 ? '' : 's'} · {s.wins}W {s.losses}L{s.breakeven > 0 ? ` ${s.breakeven}B/E` : ''}
                {s.wins + s.losses > 0 ? ` · ${Math.round(s.winRate * 100)}% win rate` : ''}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full rounded-full ${s.totalPnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
                style={{ width: `${Math.max(6, (s.trades / maxTrades) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
