#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { decodeRasterToPng } = require('../src/core/extractor/raster')

function main () {
  const inPath = process.argv[2]
  if (!inPath) {
    console.error('usage: node scripts/decode-capture.js <capture.bin> [output.png]')
    process.exit(1)
  }
  if (!fs.existsSync(inPath)) {
    console.error(`not found: ${inPath}`)
    process.exit(1)
  }
  const outPath = process.argv[3] || inPath.replace(/\.bin$/, '.png')

  const bytes = fs.readFileSync(inPath)
  const result = decodeRasterToPng(bytes)
  if (!result) {
    console.error(`no GS v 0 raster blocks found in ${inPath} (${bytes.length} bytes)`)
    process.exit(2)
  }
  fs.writeFileSync(outPath, result.pngBuffer)
  console.log(`decoded ${result.blockCount} raster blocks`)
  console.log(`bitmap: ${result.width} x ${result.height} px`)
  if (result.nonZeroModes > 0) {
    console.log(`note: ${result.nonZeroModes} blocks used double-width/height mode (ignored, decoded at native res)`)
  }
  console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes)`)
}

main()
