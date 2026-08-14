const API_KEY_STORAGE_KEY = 'trading-journal:anthropic-api-key'
const MODEL_STORAGE_KEY = 'trading-journal:ai-model'

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
