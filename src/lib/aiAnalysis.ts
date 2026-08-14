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

function buildPrompt(trade: TradeContext): string {
  return `You are analyzing a trading chart screenshot for a personal trading journal.

Trade details:
- Symbol: ${trade.symbol}
- Direction: ${trade.direction}
- Outcome: ${trade.outcome}
- P&L: ${trade.pnl ?? 'not recorded'}
- Risk:Reward: ${trade.riskReward ?? 'not recorded'}
- Tagged confluences: ${trade.confluences.join(', ') || 'none'}
- Tagged mistakes: ${trade.mistakes.join(', ') || 'none'}

Look at the actual chart in the screenshot. Based on what's visible (price action, wicks, structure, levels, liquidity), explain in 3-5 concise sentences why this trade likely won or lost. Be specific to what you see on the chart, not generic advice. If it connects to the tagged confluences or mistakes, say so. Write directly to the trader, second person, no preamble.`
}

export async function analyzeTradeScreenshot(
  trade: TradeContext,
  screenshotBlob: Blob,
): Promise<AIAnalysisResult> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Add one in Settings first.')
  }

  const model = getAiModel()
  const base64 = await blobToBase64(screenshotBlob)
  const mediaType = normalizeMediaType(screenshotBlob.type)

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

  const response = await client.messages.create({
    model,
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: buildPrompt(trade) },
        ],
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
