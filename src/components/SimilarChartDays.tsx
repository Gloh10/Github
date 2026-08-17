import { useEffect, useState } from 'react'
import type { Trade } from '../types'
import { findSimilarChartDays, type SimilarDayPair } from '../lib/chartSimilarity'
import { ScreenshotThumb } from './ScreenshotThumb'

export function SimilarChartDays({
  trades,
  onSelectDay,
}: {
  trades: Trade[]
  onSelectDay: (date: string) => void
}) {
  const [pairs, setPairs] = useState<SimilarDayPair[] | null>(null)

  useEffect(() => {
    let active = true
    setPairs(null)
    findSimilarChartDays(trades).then((result) => {
      if (active) setPairs(result)
    })
    return () => {
      active = false
    }
  }, [trades])

  if (pairs === null || pairs.length === 0) return null

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 lg:col-span-2">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">Similar-looking chart days</h3>
      <p className="mb-3 text-xs text-slate-500">
        A quick visual match (local, not AI) &mdash; flags charts with a similar overall look. Worth a glance, not
        proof they're the same setup.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {pairs.map((pair) => {
          const similarity = Math.round((1 - pair.distance / 64) * 100)
          return (
            <div
              key={`${pair.dateA}-${pair.dateB}-${pair.screenshotA.id}-${pair.screenshotB.id}`}
              className="rounded-lg border border-slate-800 p-2"
            >
              <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                <span>{similarity}% visually similar</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => onSelectDay(pair.dateA)} className="text-left">
                  <ScreenshotThumb id={pair.screenshotA.id} className="aspect-video w-full rounded object-cover" />
                  <span className="mt-1 block text-xs text-slate-400">{pair.dateA}</span>
                </button>
                <button onClick={() => onSelectDay(pair.dateB)} className="text-left">
                  <ScreenshotThumb id={pair.screenshotB.id} className="aspect-video w-full rounded object-cover" />
                  <span className="mt-1 block text-xs text-slate-400">{pair.dateB}</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
