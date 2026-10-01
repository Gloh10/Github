/**
 * Perceptual hash (dHash) for cheap, fully-local "does this chart look similar to that one" comparisons.
 * Not pattern recognition — it's a coarse visual fingerprint (layout/brightness gradient), so it will
 * flag charts with a similar overall look, not necessarily the same technical setup.
 */

const HASH_WIDTH = 9 // 9 columns -> 8 horizontal gradients per row
const HASH_HEIGHT = 8

export async function computeImageHash(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = HASH_WIDTH
  canvas.height = HASH_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  ctx.drawImage(bitmap, 0, 0, HASH_WIDTH, HASH_HEIGHT)
  bitmap.close?.()
  const { data } = ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT)

  const gray: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
  }

  let bits = ''
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let col = 0; col < HASH_WIDTH - 1; col++) {
      const idx = row * HASH_WIDTH + col
      bits += gray[idx] < gray[idx + 1] ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16)
  }
  return hex
}

export function hammingDistanceHex(a: string, b: string): number {
  const len = Math.max(a.length, b.length)
  let distance = 0
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16)
    distance += [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][x]
  }
  return distance
}
