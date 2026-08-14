import { useEffect, useMemo, useState } from 'react'
import type { Screenshot, Trade } from '../types'
import { getScreenshotsForTrade } from '../lib/db'
import { generateAnalysis } from '../lib/tradingKnowledge'
import { analyzeTradeScreenshot } from '../lib/aiAnalysis'
import { getApiKey } from '../lib/settings'
import { ScreenshotThumb } from './ScreenshotThumb'
import { MistakeStreakBadge } from './MistakeStreakBadge'
import { AnalysisView } from './AnalysisView'
import type { MistakeStreak } from '../lib/insights'

const outcomeStyles: Record<Trade['outcome'], string> = {
  win: 'bg-emerald-500/15 text-emerald-400',
  loss: 'bg-rose-500/15 text-rose-400',
  breakeven: 'bg-amber-500/15 text-amber-400',
}

export function TradeDetail({
  trade,
  streaks,
  onEdit,
  onDelete,
  onUpdateTrade,
}: {
  trade: Trade
  streaks: MistakeStreak[]
  onEdit: () => void
  onDelete: () => void
  onUpdateTrade: (trade: Trade) => Promise<void>
}) {
  const [screenshots, setScreenshots] = useState<Screenshot[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [aiAnalysis, setAiAnalysis] = useState(trade.aiAnalysis ?? null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  useEffect(() => {
    getScreenshotsForTrade(trade.id).then(setScreenshots)
  }, [trade.id])

  useEffect(() => {
    setAiAnalysis(trade.aiAnalysis ?? null)
    setAiError(null)
  }, [trade.id, trade.aiAnalysis])

  const tradeStreaks = streaks.filter((s) => trade.mistakes.includes(s.mistake) && s.tradeIds[0] === trade.id)
  const analysis = useMemo(() => generateAnalysis(trade), [trade])

  const handleAnalyze = async () => {
    if (screenshots.length === 0) return
    setAiLoading(true)
    setAiError(null)
    try {
      const result = await analyzeTradeScreenshot(trade, screenshots[0].blob)
      setAiAnalysis(result)
      await onUpdateTrade({ ...trade, aiAnalysis: result })
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Something went wrong analyzing this screenshot.')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xl font-bold text-slate-100">{trade.symbol}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${outcomeStyles[trade.outcome]}`}>
          {trade.outcome === 'breakeven' ? 'Breakeven' : trade.outcome}
        </span>
        <span className={`text-sm font-medium capitalize ${trade.direction === 'long' ? 'text-emerald-500' : 'text-rose-500'}`}>
          {trade.direction}
        </span>
        <span className="text-sm text-slate-500">
          {trade.date} · {trade.time}
        </span>
        {trade.pnl !== null && (
          <span className={`text-sm font-medium ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {trade.pnl >= 0 ? '+' : ''}
            {trade.pnl}
          </span>
        )}
        {trade.riskReward !== null && <span className="text-sm text-slate-500">R:R {trade.riskReward}</span>}
      </div>

      {tradeStreaks.length > 0 && (
        <div className="space-y-2">
          {tradeStreaks.map((s) => (
            <MistakeStreakBadge key={s.mistake} streak={s} />
          ))}
        </div>
      )}

      {screenshots.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {screenshots.map((shot) => (
            <ScreenshotThumb
              key={shot.id}
              id={shot.id}
              className="aspect-video w-full rounded-lg border border-slate-800 object-cover"
              onClick={() => setLightbox(shot.id)}
            />
          ))}
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-200">AI screenshot analysis</h3>
          <button
            onClick={handleAnalyze}
            disabled={aiLoading || screenshots.length === 0 || !getApiKey()}
            className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {aiLoading ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze with AI'}
          </button>
        </div>
        {screenshots.length === 0 ? (
          <p className="text-sm text-slate-500">Add a screenshot to this trade to enable AI analysis.</p>
        ) : !getApiKey() ? (
          <p className="text-sm text-slate-500">Add an Anthropic API key in Settings to enable AI analysis.</p>
        ) : null}
        {aiError && <p className="text-sm text-rose-400">{aiError}</p>}
        {aiAnalysis && (
          <div>
            <p className="whitespace-pre-wrap text-sm text-slate-300">{aiAnalysis.text}</p>
            <p className="mt-2 text-xs text-slate-600">
              Generated {new Date(aiAnalysis.generatedAt).toLocaleString()} · {aiAnalysis.model}
            </p>
          </div>
        )}
      </div>

      {trade.confluences.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Confluences</h3>
          <div className="flex flex-wrap gap-1.5">
            {trade.confluences.map((c) => (
              <span key={c} className="rounded-full bg-indigo-500/15 px-2.5 py-1 text-xs font-medium text-indigo-300">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {trade.mistakes.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Mistakes</h3>
          <div className="flex flex-wrap gap-1.5">
            {trade.mistakes.map((m) => (
              <span key={m} className="rounded-full bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {trade.personalNotes && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Personal notes</h3>
          <p className="whitespace-pre-wrap text-sm text-slate-300">{trade.personalNotes}</p>
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Analysis</h3>
        <AnalysisView analysis={analysis} />
      </div>

      <div className="flex justify-end gap-3 border-t border-slate-800 pt-4">
        <button
          onClick={onDelete}
          className="rounded-lg px-4 py-2 text-sm font-medium text-rose-400 hover:bg-rose-500/10"
        >
          Delete
        </button>
        <button
          onClick={onEdit}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Edit
        </button>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-6"
          onClick={() => setLightbox(null)}
        >
          <ScreenshotThumb id={lightbox} className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  )
}
