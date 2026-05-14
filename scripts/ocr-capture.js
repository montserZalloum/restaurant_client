#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const Tesseract = require('tesseract.js')
const { decodeRasterToPng } = require('../src/core/extractor/raster')

async function main () {
  const inPath = process.argv[2]
  if (!inPath) {
    console.error('usage: node scripts/ocr-capture.js <capture.bin>')
    process.exit(1)
  }

  let pngBuffer
  if (inPath.endsWith('.png')) {
    pngBuffer = fs.readFileSync(inPath)
  } else {
    const bytes = fs.readFileSync(inPath)
    const decoded = decodeRasterToPng(bytes)
    if (!decoded) {
      console.error('no raster blocks in', inPath)
      process.exit(2)
    }
    pngBuffer = decoded.pngBuffer
    console.log(`decoded ${decoded.blockCount} raster blocks → ${decoded.width}x${decoded.height} PNG`)
  }

  const t0 = Date.now()
  console.log('running OCR (digits + #) ...')
  const { data } = await Tesseract.recognize(pngBuffer, 'eng', {
    logger: m => { if (m.status === 'recognizing text') process.stdout.write(`\r  ${Math.round(m.progress * 100)}%`) },
    tessedit_char_whitelist: '0123456789#:/AMP -'
  })
  process.stdout.write('\n')
  const ms = Date.now() - t0

  console.log(`OCR took ${ms} ms, confidence ${data.confidence.toFixed(1)}%`)
  console.log('--- raw OCR text ---')
  console.log(data.text)
  console.log('--- regex match: #(\\d+) ---')
  const m = data.text.match(/#(\d{4,})/)
  if (m) {
    console.log(`FOUND order number: ${m[1]}`)
  } else {
    console.log('NO match for #(\\d{4,})')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
