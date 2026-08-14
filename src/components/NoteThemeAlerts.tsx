import type { NoteTheme } from '../lib/notesInsights'

export function NoteThemeAlerts({ themes }: { themes: NoteTheme[] }) {
  if (themes.length === 0) return null

  return (
    <div className="mb-6 space-y-2">
      {themes.map((t) => (
        <div
          key={t.phrase}
          className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300"
        >
          <span className="mt-0.5">📝</span>
          <span>
            You've written <span className="font-semibold">&ldquo;{t.phrase}&rdquo;</span> in your notes on{' '}
            <span className="font-semibold">{t.count} different trades</span> &mdash; worth noticing as a pattern.
          </span>
        </div>
      ))}
    </div>
  )
}
