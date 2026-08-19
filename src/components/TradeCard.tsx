import type { Trade } from '../types'
import { ScreenshotThumb } from './ScreenshotThumb'

const outcomeStyles: Record<Trade['outcome'], string> = {
  win: 'bg-emerald-500/15 text-emerald-400',
  loss: 'bg-rose-500/15 text-rose-400',
  breakeven: 'bg-amber-500/15 text-amber-400',
}

export function TradeCard({ trade, onClick }: { trade: Trade; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-left transition hover:border-slate-600"
    >
      <div className="aspect-video w-full bg-slate-950">
        {trade.screenshotIds.length > 0 ? (
          <ScreenshotThumb
            id={trade.screenshotIds[0]}
            className="h-full w-full object-cover transition group-hover:opacity-90"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">
            No screenshot
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-100">{trade.symbol}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${outcomeStyles[trade.outcome]}`}>
            {trade.outcome === 'breakeven' ? 'B/E' : trade.outcome}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {trade.date} · {trade.time}
          </span>
          <span className={`capitalize ${trade.direction === 'long' ? 'text-emerald-500' : 'text-rose-500'}`}>
            {trade.direction}
          </span>
        </div>
        {trade.mistakes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {trade.mistakes.slice(0, 3).map((m) => (
              <span key={m} className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-400">
                {m}
              </span>
            ))}
            {trade.mistakes.length > 3 && (
              <span className="text-[11px] text-slate-500">+{trade.mistakes.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </button>
  )
}
