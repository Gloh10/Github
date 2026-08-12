import { useMemo, useState } from 'react'
import { DEFAULT_CONFLUENCES, DEFAULT_MISTAKES } from '../types'
import type { Direction, Outcome, Screenshot, Trade } from '../types'
import { createTradeId } from '../lib/db'
import { TagInput } from './TagInput'
import { ScreenshotUploader, type PendingImage } from './ScreenshotUploader'

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5)
}

function emptyTrade(): Trade {
  const now = Date.now()
  return {
    id: createTradeId(),
    date: todayDate(),
    time: nowTime(),
    symbol: '',
    direction: 'long',
    outcome: 'win',
    pnl: null,
    riskReward: null,
    confluences: [],
    mistakes: [],
    whatWentRight: '',
    whatWentWrong: '',
    improvementNotes: '',
    screenshotIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function TradeForm({
  initial,
  existingScreenshots,
  allConfluences,
  allMistakes,
  onSave,
  onCancel,
}: {
  initial?: Trade
  existingScreenshots: Screenshot[]
  allConfluences: string[]
  allMistakes: string[]
  onSave: (trade: Trade, newFiles: File[], removedScreenshotIds: string[]) => Promise<void>
  onCancel: () => void
}) {
  const [trade, setTrade] = useState<Trade>(() => initial ?? emptyTrade())
  const [pending, setPending] = useState<PendingImage[]>([])
  const [removedIds, setRemovedIds] = useState<string[]>([])
  const [kept, setKept] = useState<Screenshot[]>(existingScreenshots)
  const [saving, setSaving] = useState(false)

  const confluenceSuggestions = useMemo(
    () => Array.from(new Set([...DEFAULT_CONFLUENCES, ...allConfluences])),
    [allConfluences],
  )
  const mistakeSuggestions = useMemo(
    () => Array.from(new Set([...DEFAULT_MISTAKES, ...allMistakes])),
    [allMistakes],
  )

  const update = <K extends keyof Trade>(key: K, value: Trade[K]) =>
    setTrade((t) => ({ ...t, [key]: value }))

  const removeExisting = (id: string) => {
    setKept((k) => k.filter((s) => s.id !== id))
    setRemovedIds((ids) => [...ids, id])
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!trade.symbol.trim()) return
    setSaving(true)
    try {
      await onSave(
        { ...trade, symbol: trade.symbol.trim().toUpperCase(), updatedAt: Date.now() },
        pending.map((p) => p.file),
        removedIds,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Date</label>
          <input
            type="date"
            required
            value={trade.date}
            onChange={(e) => update('date', e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Time</label>
          <input
            type="time"
            required
            value={trade.time}
            onChange={(e) => update('time', e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div className="col-span-2 sm:col-span-2">
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Symbol</label>
          <input
            type="text"
            required
            placeholder="e.g. ES, EURUSD, AAPL"
            value={trade.symbol}
            onChange={(e) => update('symbol', e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm uppercase text-slate-100 placeholder:text-slate-500 placeholder:normal-case focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Direction</label>
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {(['long', 'short'] as Direction[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => update('direction', d)}
                className={`flex-1 py-2 text-sm font-medium capitalize transition ${
                  trade.direction === d
                    ? d === 'long'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-rose-600 text-white'
                    : 'bg-slate-950 text-slate-400 hover:text-slate-200'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Outcome</label>
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {(['win', 'loss', 'breakeven'] as Outcome[]).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => update('outcome', o)}
                className={`flex-1 py-2 text-xs font-medium capitalize transition sm:text-sm ${
                  trade.outcome === o
                    ? o === 'win'
                      ? 'bg-emerald-600 text-white'
                      : o === 'loss'
                        ? 'bg-rose-600 text-white'
                        : 'bg-amber-600 text-white'
                    : 'bg-slate-950 text-slate-400 hover:text-slate-200'
                }`}
              >
                {o === 'breakeven' ? 'B/E' : o}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">P&amp;L</label>
          <input
            type="number"
            step="any"
            placeholder="optional"
            value={trade.pnl ?? ''}
            onChange={(e) => update('pnl', e.target.value === '' ? null : Number(e.target.value))}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">R:R</label>
          <input
            type="number"
            step="any"
            placeholder="optional"
            value={trade.riskReward ?? ''}
            onChange={(e) => update('riskReward', e.target.value === '' ? null : Number(e.target.value))}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <ScreenshotUploader
        pending={pending}
        onPendingChange={setPending}
        existing={kept}
        onRemoveExisting={removeExisting}
      />

      <TagInput
        label="Confluences (why you took the trade)"
        values={trade.confluences}
        onChange={(v) => update('confluences', v)}
        suggestions={confluenceSuggestions}
        tagClassName="bg-indigo-500/15 text-indigo-300"
        placeholder="e.g. Support/Resistance…"
      />

      <TagInput
        label="Mistakes (be honest)"
        values={trade.mistakes}
        onChange={(v) => update('mistakes', v)}
        suggestions={mistakeSuggestions}
        tagClassName="bg-rose-500/15 text-rose-300"
        placeholder="e.g. FOMO entry…"
      />

      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-300">What went right</label>
        <textarea
          rows={2}
          value={trade.whatWentRight}
          onChange={(e) => update('whatWentRight', e.target.value)}
          className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          placeholder="Followed my plan, waited for confirmation…"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-300">What went wrong</label>
        <textarea
          rows={2}
          value={trade.whatWentWrong}
          onChange={(e) => update('whatWentWrong', e.target.value)}
          className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          placeholder="Entered before confirmation, sized too big…"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-300">
          How to improve next time
        </label>
        <textarea
          rows={2}
          value={trade.improvementNotes}
          onChange={(e) => update('improvementNotes', e.target.value)}
          className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          placeholder="Wait for retest, cut size on countertrend setups…"
        />
      </div>

      <div className="flex justify-end gap-3 border-t border-slate-800 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save trade'}
        </button>
      </div>
    </form>
  )
}
