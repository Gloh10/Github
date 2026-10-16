import type { AnalysisLine, TradeAnalysis, TraderSource } from '../lib/tradingKnowledge'
import { TRADER_LABELS } from '../lib/tradingKnowledge'

const SOURCE_STYLES: Record<TraderSource, string> = {
  powell: 'bg-sky-500/15 text-sky-300',
  pbtrades: 'bg-violet-500/15 text-violet-300',
  dodgy: 'bg-orange-500/15 text-orange-300',
  general: 'bg-slate-700 text-slate-300',
}

function SourceBadge({ source }: { source: TraderSource }) {
  return (
    <span
      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SOURCE_STYLES[source]}`}
    >
      {TRADER_LABELS[source]}
    </span>
  )
}

function AnalysisSection({
  title,
  lines,
  emptyText,
}: {
  title: string
  lines: AnalysisLine[]
  emptyText: string
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {lines.map((line, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-300">
              <SourceBadge source={line.source} />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AnalysisView({ analysis }: { analysis: TradeAnalysis }) {
  return (
    <div className="space-y-4">
      <AnalysisSection
        title="What went right"
        lines={analysis.whatWentRight}
        emptyText="Nothing to show yet — tag a confluence to see the analysis."
      />
      <AnalysisSection
        title="What went wrong"
        lines={analysis.whatWentWrong}
        emptyText="No mistakes tagged on this trade."
      />
      <AnalysisSection
        title="How to improve"
        lines={analysis.improvementTips}
        emptyText="No specific tips for this trade."
      />
    </div>
  )
}
