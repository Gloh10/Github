import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Trade, Screenshot } from '../types'
import { computeImageHash } from './imageHash'

interface JournalDB extends DBSchema {
  trades: {
    key: string
    value: Trade
    indexes: { 'by-date': string }
  }
  screenshots: {
    key: string
    value: Screenshot
    indexes: { 'by-trade': string }
  }
}

let dbPromise: Promise<IDBPDatabase<JournalDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<JournalDB>('trading-journal', 1, {
      upgrade(db) {
        const trades = db.createObjectStore('trades', { keyPath: 'id' })
        trades.createIndex('by-date', 'date')

        const screenshots = db.createObjectStore('screenshots', { keyPath: 'id' })
        screenshots.createIndex('by-trade', 'tradeId')
      },
    })
  }
  return dbPromise
}

function newId() {
  return crypto.randomUUID()
}

// --- Trades ---

export async function getAllTrades(): Promise<Trade[]> {
  const db = await getDB()
  const trades = await db.getAll('trades')
  return trades.sort((a, b) => {
    const at = `${a.date}T${a.time || '00:00'}`
    const bt = `${b.date}T${b.time || '00:00'}`
    const cmp = bt.localeCompare(at)
    return cmp !== 0 ? cmp : b.createdAt - a.createdAt
  })
}

export async function getTrade(id: string): Promise<Trade | undefined> {
  const db = await getDB()
  return db.get('trades', id)
}

export async function saveTrade(trade: Trade): Promise<void> {
  const db = await getDB()
  await db.put('trades', trade)
}

export function createTradeId(): string {
  return newId()
}

export async function deleteTrade(id: string): Promise<void> {
  const db = await getDB()
  const shots = await db.getAllFromIndex('screenshots', 'by-trade', id)
  const tx = db.transaction(['trades', 'screenshots'], 'readwrite')
  await Promise.all([
    ...shots.map((s) => tx.objectStore('screenshots').delete(s.id)),
    tx.objectStore('trades').delete(id),
  ])
  await tx.done
}

// --- Screenshots ---

export async function addScreenshot(tradeId: string, file: Blob, name: string): Promise<Screenshot> {
  const db = await getDB()
  const hash = await computeImageHash(file).catch(() => undefined)
  const screenshot: Screenshot = {
    id: newId(),
    tradeId,
    blob: file,
    name,
    type: file.type || 'image/png',
    hash,
    createdAt: Date.now(),
  }
  await db.put('screenshots', screenshot)
  return screenshot
}

export async function getScreenshot(id: string): Promise<Screenshot | undefined> {
  const db = await getDB()
  return db.get('screenshots', id)
}

export async function getScreenshotsForTrade(tradeId: string): Promise<Screenshot[]> {
  const db = await getDB()
  return db.getAllFromIndex('screenshots', 'by-trade', tradeId)
}

export async function getAllScreenshots(): Promise<Screenshot[]> {
  const db = await getDB()
  return db.getAll('screenshots')
}

export async function setScreenshotHash(id: string, hash: string): Promise<void> {
  const db = await getDB()
  const shot = await db.get('screenshots', id)
  if (shot) {
    await db.put('screenshots', { ...shot, hash })
  }
}

export async function deleteScreenshot(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('screenshots', id)
}
