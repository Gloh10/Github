import { useMemo, useState } from 'react'
import { useTrades } from './hooks/useTrades'
import { useDismissedNoteThemes } from './hooks/useDismissedNoteThemes'
import { TradeList } from './components/TradeList'
import { TradeForm } from './components/TradeForm'
import { TradeDetail } from './components/TradeDetail'
import { TradeCard } from './components/TradeCard'
import { TradeCalendar } from './components/TradeCalendar'
import { DayOfWeekInsights } from './components/DayOfWeekInsights'
import { SimilarChartDays } from './components/SimilarChartDays'
import { NotesLog } from './components/NotesLog'
import { Dashboard } from './components/Dashboard'
import { Modal } from './components/Modal'
import { MistakeAlerts } from './components/MistakeAlerts'
import { NoteThemeAlerts } from './components/NoteThemeAlerts'
import { SettingsModal } from './components/SettingsModal'
import { getActiveMistakeStreaks, getRecentMistakeFrequency } from './lib/insights'
import { getRecurringNoteThemes } from './lib/notesInsights'
import { getScreenshotsForTrade } from './lib/db'
import type { Screenshot, Trade } from './types'

type Tab = 'journal' | 'calendar' | 'notes' | 'dashboard'
type ModalState =
  | { kind: 'new' }
  | { kind: 'edit'; trade: Trade }
  | { kind: 'view'; trade: Trade }
  | { kind: 'day'; date: string }
  | null

export default function App() {
  const { trades, loading, upsertTrade, removeTrade, saveTradeWithScreenshots } = useTrades()
  const [tab, setTab] = useState<Tab>('journal')
  const [modal, setModal] = useState<ModalState>(null)
  const [detailScreenshots, setDetailScreenshots] = useState<Screenshot[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)

  const allConfluences = useMemo(() => Array.from(new Set(trades.flatMap((t) => t.confluences))), [trades])
  const allMistakes = useMemo(() => Array.from(new Set(trades.flatMap((t) => t.mistakes))), [trades])
  const streaks = useMemo(() => getActiveMistakeStreaks(trades), [trades])
  const frequency = useMemo(() => getRecentMistakeFrequency(trades), [trades])
  const { dismissed: dismissedNoteThemes, dismiss: dismissNoteTheme } = useDismissedNoteThemes()
  const noteThemes = useMemo(
    () => getRecurringNoteThemes(trades).filter((t) => !dismissedNoteThemes.includes(t.phrase)),
    [trades, dismissedNoteThemes],
  )

  const openView = async (trade: Trade) => {
    setDetailScreenshots(await getScreenshotsForTrade(trade.id))
    setModal({ kind: 'view', trade })
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this trade and its screenshots? This cannot be undone.')) return
    await removeTrade(id)
    setModal(null)
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-lg font-bold sm:text-xl">Trading Journal</h1>
            <p className="text-xs text-slate-500">Screenshots, confluences, and lessons learned &mdash; stored locally in your browser</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 hover:border-slate-500 hover:text-slate-100"
            >
              Settings
            </button>
            <button
              onClick={() => setModal({ kind: 'new' })}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              + New Trade
            </button>
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <nav className="flex gap-1 border-t border-slate-800/0">
            {(['journal', 'calendar', 'notes', 'dashboard'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`border-b-2 px-3 py-3 text-sm font-medium capitalize transition ${
                  tab === t ? 'border-indigo-500 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {loading ? (
          <div className="py-16 text-center text-sm text-slate-500">Loading…</div>
        ) : tab === 'journal' ? (
          <>
            <MistakeAlerts streaks={streaks} frequency={frequency} />
            <NoteThemeAlerts themes={noteThemes} onDismiss={dismissNoteTheme} />
            <TradeList trades={trades} onSelect={openView} />
          </>
        ) : tab === 'calendar' ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TradeCalendar trades={trades} onSelectDay={(date) => setModal({ kind: 'day', date })} />
            <DayOfWeekInsights trades={trades} />
            <SimilarChartDays trades={trades} onSelectDay={(date) => setModal({ kind: 'day', date })} />
          </div>
        ) : tab === 'notes' ? (
          <NotesLog trades={trades} onSelect={openView} />
        ) : (
          <Dashboard trades={trades} />
        )}
      </main>

      {modal?.kind === 'new' && (
        <Modal title="New trade" onClose={() => setModal(null)} wide>
          <TradeForm
            existingScreenshots={[]}
            allConfluences={allConfluences}
            allMistakes={allMistakes}
            onCancel={() => setModal(null)}
            onSave={async (trade, files, removed) => {
              await saveTradeWithScreenshots(trade, files, removed)
              setModal(null)
            }}
          />
        </Modal>
      )}

      {modal?.kind === 'edit' && (
        <Modal title="Edit trade" onClose={() => setModal(null)} wide>
          <TradeForm
            initial={modal.trade}
            existingScreenshots={detailScreenshots}
            allConfluences={allConfluences}
            allMistakes={allMistakes}
            onCancel={() => setModal({ kind: 'view', trade: modal.trade })}
            onSave={async (trade, files, removed) => {
              await saveTradeWithScreenshots(trade, files, removed)
              setModal(null)
            }}
          />
        </Modal>
      )}

      {modal?.kind === 'view' && (
        <Modal title={`${modal.trade.symbol} — ${modal.trade.date}`} onClose={() => setModal(null)} wide>
          <TradeDetail
            trade={modal.trade}
            streaks={streaks}
            onEdit={async () => {
              setDetailScreenshots(await getScreenshotsForTrade(modal.trade.id))
              setModal({ kind: 'edit', trade: modal.trade })
            }}
            onDelete={() => handleDelete(modal.trade.id)}
            onUpdateTrade={upsertTrade}
          />
        </Modal>
      )}

      {modal?.kind === 'day' && (
        <Modal title={modal.date} onClose={() => setModal(null)} wide>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {trades
              .filter((t) => t.date === modal.date)
              .map((trade) => (
                <TradeCard key={trade.id} trade={trade} onClick={() => openView(trade)} />
              ))}
          </div>
        </Modal>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
