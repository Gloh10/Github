import type { Trade } from '../types'
import { getActiveMistakeStreaks, getRecentMistakeFrequency, getStats } from '../lib/insights'
import { MistakeAlerts } from './MistakeAlerts'

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent ?? 'text-slate-100'}`}>{value}</div>
    </div>
  )
}

function BarRow({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(6, (count / max) * 100) : 0
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-500">{count}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function Dashboard({ trades }: { trades: Trade[] }) {
  const stats = getStats(trades)
  const streaks = getActiveMistakeStreaks(trades)
  const frequency = getRecentMistakeFrequency(trades)
  const maxMistake = Math.max(1, ...stats.topMistakes.map((m) => m.count))
  const maxConfluence = Math.max(1, ...stats.topConfluences.map((c) => c.count))

  if (trades.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 py-16 text-center text-sm text-slate-500">
        Log a few trades to see your stats and patterns here.
      </div>
    )
  }

  return (
    <div>
      <MistakeAlerts streaks={streaks} frequency={frequency} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Trades" value={String(stats.total)} />
        <StatCard
          label="Win rate"
          value={`${Math.round(stats.winRate * 100)}%`}
          accent={stats.winRate >= 0.5 ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatCard
          label="Total P&L"
          value={`${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}`}
          accent={stats.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatCard label="W / L / B/E" value={`${stats.wins} / ${stats.losses} / ${stats.breakeven}`} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Most common mistakes</h3>
          {stats.topMistakes.length === 0 ? (
            <p className="text-sm text-slate-500">No mistakes logged. Keep it up.</p>
          ) : (
            <div className="space-y-3">
              {stats.topMistakes.map((m) => (
                <BarRow key={m.name} label={m.name} count={m.count} max={maxMistake} color="bg-rose-500" />
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Confluences used (win rate)</h3>
          {stats.topConfluences.length === 0 ? (
            <p className="text-sm text-slate-500">No confluences logged yet.</p>
          ) : (
            <div className="space-y-3">
              {stats.topConfluences.map((c) => (
                <div key={c.name}>
                  <BarRow label={c.name} count={c.count} max={maxConfluence} color="bg-indigo-500" />
                  <div className="mt-0.5 text-right text-xs text-slate-500">
                    {Math.round(c.winRate * 100)}% win rate
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
