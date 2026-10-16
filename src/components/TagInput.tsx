import { useState } from 'react'

export function TagInput({
  label,
  values,
  onChange,
  suggestions,
  placeholder,
  tagClassName = 'bg-slate-800 text-slate-200',
}: {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  suggestions: string[]
  placeholder?: string
  tagClassName?: string
}) {
  const [input, setInput] = useState('')

  const addTag = (tag: string) => {
    const trimmed = tag.trim()
    if (!trimmed || values.includes(trimmed)) return
    onChange([...values, trimmed])
    setInput('')
  }

  const removeTag = (tag: string) => onChange(values.filter((v) => v !== tag))

  const remaining = suggestions.filter((s) => !values.includes(s))

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-300">{label}</label>

      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((tag) => (
            <span
              key={tag}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tagClassName}`}
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="leading-none opacity-70 hover:opacity-100"
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            addTag(input)
          }
        }}
        placeholder={placeholder ?? 'Type and press Enter to add…'}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
      />

      {remaining.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {remaining.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => addTag(s)}
              className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
