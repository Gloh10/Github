import { useMemo, useState } from 'react'
import { useTrades } from './hooks/useTrades'
import { TradeList } from './components/TradeList'
import { TradeForm } from './components/TradeForm'
import { TradeDetail } from './components/TradeDetail'
import { Dashboard } from './components/Dashboard'
import { Modal } from './components/Modal'
import { MistakeAlerts } from './components/MistakeAlerts'
import { getActiveMistakeStreaks, getRecentMistakeFrequency } from './lib/insights'
import { getScreenshotsForTrade } from './lib/db'
import type { Screenshot, Trade } from './types'

type Tab = 'journal' | 'dashboard'
type ModalState = { kind: 'new' } | { kind: 'edit'; trade: Trade } | { kind: 'view'; trade: Trade } | null

export default function App() {
  const { trades, loading, removeTrade, saveTradeWithScreenshots } = useTrades()
  const [tab, setTab] = useState<Tab>('journal')
  const [modal, setModal] = useState<ModalState>(null)
  const [detailScreenshots, setDetailScreenshots] = useState<Screenshot[]>([])

  const allConfluences = useMemo(() => Array.from(new Set(trades.flatMap((t) => t.confluences))), [trades])
  const allMistakes = useMemo(() => Array.from(new Set(trades.flatMap((t) => t.mistakes))), [trades])
  const streaks = useMemo(() => getActiveMistakeStreaks(trades), [trades])
  const frequency = useMemo(() => getRecentMistakeFrequency(trades), [trades])

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
          <button
            onClick={() => setModal({ kind: 'new' })}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + New Trade
          </button>
        </div>
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <nav className="flex gap-1 border-t border-slate-800/0">
            {(['journal', 'dashboard'] as Tab[]).map((t) => (
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
            <TradeList trades={trades} onSelect={openView} />
          </>
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
          />
        </Modal>
      )}
    </div>
  )
}
