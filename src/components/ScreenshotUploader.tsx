import { useEffect, useRef, useState } from 'react'
import type { Screenshot } from '../types'
import { ScreenshotThumb } from './ScreenshotThumb'

export interface PendingImage {
  key: string
  file: File
}

function PendingThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  return (
    <div className="group relative aspect-video overflow-hidden rounded-lg border border-slate-700">
      {url && <img src={url} className="h-full w-full object-cover" alt={file.name} />}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-0 transition group-hover:opacity-100"
      >
        ✕
      </button>
    </div>
  )
}

export function ScreenshotUploader({
  pending,
  onPendingChange,
  existing,
  onRemoveExisting,
}: {
  pending: PendingImage[]
  onPendingChange: (files: PendingImage[]) => void
  existing: Screenshot[]
  onRemoveExisting: (id: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const addFiles = (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    onPendingChange([
      ...pending,
      ...images.map((file) => ({ key: crypto.randomUUID(), file })),
    ])
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length > 0) addFiles(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-300">Screenshots</label>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files) addFiles(e.dataTransfer.files)
        }}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition ${
          dragOver
            ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
            : 'border-slate-700 text-slate-400 hover:border-slate-500'
        }`}
      >
        Click to browse, drag & drop, or{' '}
        <span className="font-medium text-slate-200">paste (Ctrl/Cmd+V)</span> a chart screenshot
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {(existing.length > 0 || pending.length > 0) && (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {existing.map((shot) => (
            <div key={shot.id} className="group relative aspect-video overflow-hidden rounded-lg border border-slate-700">
              <ScreenshotThumb id={shot.id} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemoveExisting(shot.id)}
                className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-0 transition group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
          {pending.map((p) => (
            <PendingThumb
              key={p.key}
              file={p.file}
              onRemove={() => onPendingChange(pending.filter((x) => x.key !== p.key))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
