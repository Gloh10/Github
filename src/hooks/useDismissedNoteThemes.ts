import { useCallback, useState } from 'react'
import { addDismissedNoteTheme, getDismissedNoteThemes } from '../lib/settings'

export function useDismissedNoteThemes() {
  const [dismissed, setDismissed] = useState<string[]>(() => getDismissedNoteThemes())

  const dismiss = useCallback((phrase: string) => {
    addDismissedNoteTheme(phrase)
    setDismissed(getDismissedNoteThemes())
  }, [])

  return { dismissed, dismiss }
}
