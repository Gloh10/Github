import type { MistakeFrequency, MistakeStreak } from '../lib/insights'
import { MistakeStreakBadge } from './MistakeStreakBadge'

export function MistakeAlerts({
  streaks,
  frequency,
}: {
  streaks: MistakeStreak[]
  frequency: MistakeFrequency[]
}) {
  const frequencyOnly = frequency.filter((f) => !streaks.some((s) => s.mistake === f.mistake))

  if (streaks.length === 0 && frequencyOnly.length === 0) return null

  return (
    <div className="mb-6 space-y-2">
      {streaks.map((s) => (
        <MistakeStreakBadge key={s.mistake} streak={s} />
      ))}
      {frequencyOnly.map((f) => (
        <div
          key={f.mistake}
          className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300"
        >
          <span className="mt-0.5">👀</span>
          <span>
            <span className="font-semibold">"{f.mistake}"</span> has shown up {f.count} times in your last{' '}
            {f.windowSize} trades &mdash; keep an eye on it.
          </span>
        </div>
      ))}
    </div>
  )
}
