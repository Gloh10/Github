import { useMemo, useState } from 'react'
import type { Trade } from '../types'
import { getTradesByDate, summarizeDay } from '../lib/calendar'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function toDateKey(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, '0')
  const m = String(month + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function TradeCalendar({
  trades,
  onSelectDay,
}: {
  trades: Trade[]
  onSelectDay: (date: string) => void
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })

  const byDate = useMemo(() => getTradesByDate(trades), [trades])

  const { year, month } = cursor
  const firstOfMonth = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const leadingBlanks = firstOfMonth.getDay()
  const today = todayKey()

  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const monthLabel = firstOfMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  const goToMonth = (delta: number) => {
    setCursor(({ year, month }) => {
      const next = new Date(year, month + delta, 1)
      return { year: next.getFullYear(), month: next.getMonth() }
    })
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() => goToMonth(-1)}
          className="rounded-lg px-2.5 py-1.5 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Previous month"
        >
          ←
        </button>
        <h3 className="text-sm font-semibold text-slate-200">{monthLabel}</h3>
        <button
          onClick={() => goToMonth(1)}
          className="rounded-lg px-2.5 py-1.5 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Next month"
        >
          →
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-slate-600">
            {label}
          </div>
        ))}

        {cells.map((day, i) => {
          if (day === null) return <div key={`blank-${i}`} />

          const dateKey = toDateKey(year, month, day)
          const dayTrades = byDate.get(dateKey)
          const summary = dayTrades ? summarizeDay(dateKey, dayTrades) : null
          const isToday = dateKey === today

          let tone = 'border-slate-800 bg-slate-950/40'
          if (summary) {
            if (summary.wins > summary.losses) tone = 'border-emerald-500/30 bg-emerald-500/10'
            else if (summary.losses > summary.wins) tone = 'border-rose-500/30 bg-rose-500/10'
            else tone = 'border-amber-500/30 bg-amber-500/10'
          }

          return (
            <button
              key={dateKey}
              onClick={() => summary && onSelectDay(dateKey)}
              disabled={!summary}
              className={`flex aspect-square flex-col items-center justify-center rounded-lg border p-1 text-center transition ${tone} ${
                summary ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
              } ${isToday ? 'ring-1 ring-indigo-500' : ''}`}
            >
              <span className="text-xs font-medium text-slate-400">{day}</span>
              {summary && (
                <>
                  <span className="text-[11px] font-semibold text-slate-200">{summary.trades.length}</span>
                  <span className="text-[10px] text-slate-500">
                    {summary.wins}W {summary.losses}L
                  </span>
                </>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
