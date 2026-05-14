'use strict'

const { PNG } = require('pngjs')

const GS = 0x1D
const V = 0x76
const ZERO = 0x30

function findRasterBlocks (buffer) {
  const blocks = []
  let skipped = 0
  let i = 0
  while (i <= buffer.length - 8) {
    if (buffer[i] !== GS || buffer[i + 1] !== V || buffer[i + 2] !== ZERO) {
      i++
      continue
    }
    const mode = buffer[i + 3]
    const widthBytes = buffer[i + 4] | (buffer[i + 5] << 8)
    const heightDots = buffer[i + 6] | (buffer[i + 7] << 8)
    const dataLen = widthBytes * heightDots
    const dataStart = i + 8
    const dataEnd = dataStart + dataLen

    if (widthBytes === 0 || heightDots === 0 || dataEnd > buffer.length) {
      // malformed header — skip the GS byte and keep scanning
      i++
      continue
    }
    if (mode !== 0) {
      // m=1/2/3 doubles width/height during print; we ignore the doubling for
      // OCR purposes and decode at native bitmap resolution.
      skipped++
    }

    blocks.push({
      mode,
      widthBytes,
      heightDots,
      data: buffer.slice(dataStart, dataEnd)
    })
    i = dataEnd
  }
  return { blocks, nonZeroModes: skipped }
}

function stitchBlocksToPng (blocks) {
  if (blocks.length === 0) return null

  const widthBytes = Math.max(...blocks.map(b => b.widthBytes))
  const widthPixels = widthBytes * 8
  const totalHeight = blocks.reduce((sum, b) => sum + b.heightDots, 0)

  const png = new PNG({ width: widthPixels, height: totalHeight })
  png.data.fill(0xFF) // RGBA white

  let yOffset = 0
  for (const block of blocks) {
    for (let row = 0; row < block.heightDots; row++) {
      for (let col = 0; col < block.widthBytes; col++) {
        const byte = block.data[row * block.widthBytes + col]
        if (byte === 0) continue // shortcut: 8 white pixels
        for (let bit = 0; bit < 8; bit++) {
          if ((byte >> (7 - bit)) & 1) {
            const x = col * 8 + bit
            const y = yOffset + row
            const idx = (y * widthPixels + x) * 4
            png.data[idx] = 0
            png.data[idx + 1] = 0
            png.data[idx + 2] = 0
            // alpha already 0xFF
          }
        }
      }
    }
    yOffset += block.heightDots
  }

  return { png, width: widthPixels, height: totalHeight }
}

/**
 * Decode an ESC/POS byte stream into a PNG of the raster portion of the receipt.
 * Returns null if no GS v 0 blocks are found (i.e. the stream is plain text).
 */
function decodeRasterToPng (buffer) {
  const { blocks, nonZeroModes } = findRasterBlocks(buffer)
  if (blocks.length === 0) return null
  const stitched = stitchBlocksToPng(blocks)
  if (!stitched) return null
  return {
    pngBuffer: PNG.sync.write(stitched.png),
    width: stitched.width,
    height: stitched.height,
    blockCount: blocks.length,
    nonZeroModes
  }
}

module.exports = { findRasterBlocks, stitchBlocksToPng, decodeRasterToPng }
