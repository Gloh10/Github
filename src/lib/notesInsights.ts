import type { Trade } from '../types'

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'is', 'was', 'were', 'be', 'been', 'being', 'am', 'are',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'my', 'me', 'we', 'our', 'you', 'your',
  'he', 'she', 'they', 'them', 'his', 'her', 'their',
  'not', 'no', 'nor', 'did', 'do', 'does', 'doing', 'done',
  'had', 'have', 'has', 'having',
  'so', 'too', 'very', 'just', 'then', 'than', 'as', 'if', 'when', 'while',
  'again', 'next', 'time', 'trade', 'trades', 'today', 'here', 'there',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function extractPhrases(text: string): Set<string> {
  const words = tokenize(text)
  const phrases = new Set<string>()

  words.forEach((w) => {
    if (w.length >= 4 && !STOPWORDS.has(w)) phrases.add(w)
  })

  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i]
    const b = words[i + 1]
    if (a.length >= 3 && b.length >= 3 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) {
      phrases.add(`${a} ${b}`)
    }
  }

  return phrases
}

export interface NoteTheme {
  phrase: string
  count: number
  tradeIds: string[]
}

function dedupeSubsumed(themes: NoteTheme[]): NoteTheme[] {
  const byPhraseLength = [...themes].sort((a, b) => b.phrase.split(' ').length - a.phrase.split(' ').length)
  const kept: NoteTheme[] = []
  for (const theme of byPhraseLength) {
    const subsumed = kept.some((k) => k.phrase !== theme.phrase && k.phrase.includes(theme.phrase) && k.count >= theme.count)
    if (!subsumed) kept.push(theme)
  }
  return kept.sort((a, b) => b.count - a.count)
}

/** Words/phrases that show up in your personal notes across 2+ different trades. */
export function getRecurringNoteThemes(trades: Trade[], minCount = 2): NoteTheme[] {
  const counts = new Map<string, { count: number; tradeIds: string[] }>()

  for (const t of trades) {
    if (!t.personalNotes?.trim()) continue
    const phrases = extractPhrases(t.personalNotes)
    for (const phrase of phrases) {
      const entry = counts.get(phrase) ?? { count: 0, tradeIds: [] }
      entry.count += 1
      entry.tradeIds.push(t.id)
      counts.set(phrase, entry)
    }
  }

  const themes = [...counts.entries()]
    .map(([phrase, { count, tradeIds }]) => ({ phrase, count, tradeIds }))
    .filter((t) => t.count >= minCount)

  return dedupeSubsumed(themes)
}
