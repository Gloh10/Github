import type { MistakeStreak } from '../lib/insights'

export function MistakeStreakBadge({ streak }: { streak: MistakeStreak }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
      <span className="mt-0.5">⚠️</span>
      <span>
        You've repeated <span className="font-semibold">"{streak.mistake}"</span> in{' '}
        <span className="font-semibold">{streak.streak} trades in a row</span>. Time to address this pattern.
      </span>
    </div>
  )
}
