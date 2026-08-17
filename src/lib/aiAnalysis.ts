import Anthropic from '@anthropic-ai/sdk'
import type { AIAnalysisResult, Trade } from '../types'
import { getApiKey, getAiModel } from './settings'

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number]

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function normalizeMediaType(type: string): SupportedMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(type) ? (type as SupportedMediaType) : 'image/png'
}

type TradeContext = Pick<Trade, 'symbol' | 'direction' | 'outcome' | 'pnl' | 'riskReward' | 'confluences' | 'mistakes'>

function buildPrompt(trade: TradeContext, imageCount: number): string {
  const imageNote =
    imageCount > 1
      ? `You've been given ${imageCount} screenshots from this trade, likely different timeframes (e.g. a higher timeframe for context and a 1-minute chart for the exact entry). Look at all of them together and connect what you see across timeframes — don't analyze them in isolation.`
      : ''

  return `You are analyzing trading chart screenshot(s) for a personal trading journal.

Trade details:
- Symbol: ${trade.symbol}
- Direction: ${trade.direction}
- Outcome: ${trade.outcome}
- P&L: ${trade.pnl ?? 'not recorded'}
- Risk:Reward: ${trade.riskReward ?? 'not recorded'}
- Tagged confluences: ${trade.confluences.join(', ') || 'none'}
- Tagged mistakes: ${trade.mistakes.join(', ') || 'none'}

${imageNote}

Look at the actual chart(s). Based on what's visible (price action, wicks, structure, levels, liquidity, entry timing), explain in 4-6 concise sentences why this trade likely won or lost. Be specific to what you see on the chart, not generic advice. If the entry timing (visible on a lower timeframe) looks early, late, or well-timed relative to the higher-timeframe context, say so explicitly. If it connects to the tagged confluences or mistakes, say so. Write directly to the trader, second person, no preamble.`
}

export async function analyzeTradeScreenshots(
  trade: TradeContext,
  screenshotBlobs: Blob[],
): Promise<AIAnalysisResult> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Add one in Settings first.')
  }
  if (screenshotBlobs.length === 0) {
    throw new Error('No screenshots to analyze.')
  }

  const model = getAiModel()
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

  const imageBlocks: Anthropic.ImageBlockParam[] = await Promise.all(
    screenshotBlobs.map(async (blob) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: normalizeMediaType(blob.type),
        data: await blobToBase64(blob),
      },
    })),
  )

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    messages: [
      {
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: buildPrompt(trade, screenshotBlobs.length) }],
      },
    ],
  })

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return { text, model, generatedAt: Date.now() }
}
