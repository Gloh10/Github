import type { Trade } from '../types'

export function NotesLog({ trades, onSelect }: { trades: Trade[]; onSelect: (trade: Trade) => void }) {
  const withNotes = [...trades]
    .filter((t) => t.personalNotes?.trim())
    .sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`))

  if (withNotes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 py-16 text-center text-sm text-slate-500">
        No personal notes yet. Add one from a trade's form to see it here.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {withNotes.map((trade) => (
        <button
          key={trade.id}
          onClick={() => onSelect(trade)}
          className="block w-full rounded-xl border border-slate-800 bg-slate-900 p-4 text-left transition hover:border-slate-600"
        >
          <div className="mb-1.5 flex items-center gap-2 text-xs text-slate-500">
            <span className="font-medium text-slate-300">{trade.date}</span>
            <span>·</span>
            <span>{trade.time}</span>
            <span>·</span>
            <span className="font-semibold text-slate-400">{trade.symbol}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-slate-300">{trade.personalNotes}</p>
        </button>
      ))}
    </div>
  )
}
