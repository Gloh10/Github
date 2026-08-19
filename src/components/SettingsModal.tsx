import { useState } from 'react'
import { Modal } from './Modal'
import { clearApiKey, getAiModel, getApiKey, setAiModel, setApiKey } from '../lib/settings'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState(getApiKey() ?? '')
  const [model, setModel] = useState(getAiModel())
  const [saved, setSaved] = useState(false)

  const save = () => {
    if (key.trim()) {
      setApiKey(key.trim())
    } else {
      clearApiKey()
    }
    setAiModel(model)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Anthropic API key</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Stored only in this browser&rsquo;s local storage, never sent anywhere except Anthropic&rsquo;s API. Get a
            key at{' '}
            <a
              href="https://console.anthropic.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:underline"
            >
              console.anthropic.com
            </a>
            . Only needed for &ldquo;Analyze with AI&rdquo; on a trade&rsquo;s screenshot — everything else in this
            app works without it.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-300">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="claude-sonnet-5">Claude Sonnet 5 — higher quality</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 — cheaper, faster</option>
          </select>
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-800 pt-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-100"
          >
            Close
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
