import type { Trade, Screenshot } from '../types'
import { getAllScreenshots, setScreenshotHash } from './db'
import { computeImageHash, hammingDistanceHex } from './imageHash'

export interface SimilarDayPair {
  dateA: string
  dateB: string
  distance: number // 0-64, lower = more similar
  screenshotA: Screenshot
  screenshotB: Screenshot
}

/** Max dHash Hamming distance (out of 64 bits) still counted as "similar." Lower = stricter. */
const SIMILARITY_THRESHOLD = 12

async function ensureHash(screenshot: Screenshot): Promise<string | undefined> {
  if (screenshot.hash) return screenshot.hash
  try {
    const hash = await computeImageHash(screenshot.blob)
    await setScreenshotHash(screenshot.id, hash)
    return hash
  } catch {
    return undefined
  }
}

/** Finds pairs of screenshots from different days that look visually similar (local perceptual hash, not AI). */
export async function findSimilarChartDays(
  trades: Trade[],
  threshold = SIMILARITY_THRESHOLD,
): Promise<SimilarDayPair[]> {
  const tradeDateById = new Map(trades.map((t) => [t.id, t.date]))
  const allScreenshots = await getAllScreenshots()
  const relevant = allScreenshots.filter((s) => tradeDateById.has(s.tradeId))

  const withHash = await Promise.all(
    relevant.map(async (s) => ({
      screenshot: s,
      date: tradeDateById.get(s.tradeId) as string,
      hash: await ensureHash(s),
    })),
  )
  const usable = withHash.filter((s): s is { screenshot: Screenshot; date: string; hash: string } => Boolean(s.hash))

  const pairs: SimilarDayPair[] = []
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]
      const b = usable[j]
      if (a.date === b.date) continue
      const distance = hammingDistanceHex(a.hash, b.hash)
      if (distance <= threshold) {
        pairs.push({ dateA: a.date, dateB: b.date, distance, screenshotA: a.screenshot, screenshotB: b.screenshot })
      }
    }
  }

  const bestByDatePair = new Map<string, SimilarDayPair>()
  for (const p of pairs) {
    const key = [p.dateA, p.dateB].sort().join('|')
    const existing = bestByDatePair.get(key)
    if (!existing || p.distance < existing.distance) bestByDatePair.set(key, p)
  }

  return [...bestByDatePair.values()].sort((a, b) => a.distance - b.distance)
}
