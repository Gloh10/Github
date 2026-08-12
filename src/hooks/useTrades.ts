import { useCallback, useEffect, useState } from 'react'
import {
  addScreenshot,
  deleteScreenshot,
  deleteTrade as dbDeleteTrade,
  getAllTrades,
  saveTrade,
} from '../lib/db'
import type { Trade } from '../types'

export function useTrades() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const all = await getAllTrades()
    setTrades(all)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const upsertTrade = useCallback(
    async (trade: Trade) => {
      await saveTrade(trade)
      await refresh()
    },
    [refresh],
  )

  const removeTrade = useCallback(
    async (id: string) => {
      await dbDeleteTrade(id)
      await refresh()
    },
    [refresh],
  )

  const saveTradeWithScreenshots = useCallback(
    async (trade: Trade, newFiles: File[], removedScreenshotIds: string[]) => {
      for (const id of removedScreenshotIds) {
        await deleteScreenshot(id)
      }
      const keptIds = trade.screenshotIds.filter((id) => !removedScreenshotIds.includes(id))
      const newIds: string[] = []
      for (const file of newFiles) {
        const shot = await addScreenshot(trade.id, file, file.name)
        newIds.push(shot.id)
      }
      await saveTrade({ ...trade, screenshotIds: [...keptIds, ...newIds] })
      await refresh()
    },
    [refresh],
  )

  return { trades, loading, upsertTrade, removeTrade, saveTradeWithScreenshots, refresh }
}
