const API_KEY_STORAGE_KEY = 'trading-journal:anthropic-api-key'
const MODEL_STORAGE_KEY = 'trading-journal:ai-model'
const DISMISSED_NOTE_THEMES_KEY = 'trading-journal:dismissed-note-themes'

export const DEFAULT_MODEL = 'claude-sonnet-5'

export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE_KEY)
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE_KEY, key)
}

export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE_KEY)
}

export function getAiModel(): string {
  return localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL
}

export function setAiModel(model: string): void {
  localStorage.setItem(MODEL_STORAGE_KEY, model)
}

export function getDismissedNoteThemes(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_NOTE_THEMES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function addDismissedNoteTheme(phrase: string): void {
  const current = getDismissedNoteThemes()
  if (!current.includes(phrase)) {
    localStorage.setItem(DISMISSED_NOTE_THEMES_KEY, JSON.stringify([...current, phrase]))
  }
}
