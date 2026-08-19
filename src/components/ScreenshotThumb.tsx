import { useEffect, useState } from 'react'
import { getScreenshot } from '../lib/db'

export function ScreenshotThumb({
  id,
  onClick,
  className = '',
}: {
  id: string
  onClick?: () => void
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    getScreenshot(id).then((shot) => {
      if (!shot || !active) return
      objectUrl = URL.createObjectURL(shot.blob)
      setUrl(objectUrl)
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])

  if (!url) {
    return <div className={`animate-pulse bg-slate-800 ${className}`} />
  }

  return (
    <img
      src={url}
      onClick={onClick}
      className={`${className} ${onClick ? 'cursor-zoom-in' : ''}`}
      alt="Trade screenshot"
    />
  )
}
