'use strict'

// Smoke test for OrderExtractor.extract() — guards two regressions:
//   1. Someone reverts extract() to sync and breaks every caller silently
//      (caller awaits a plain object → still works; but the production
//      handler treats the return value as a Promise downstream).
//   2. Someone calls .extract() without `await` in a new callsite.
//
// Exercises the OCR path against a real captured raster payload whose
// filename (`...--n<NUMBER>.bin`) encodes the expected order number.

const fs = require('fs')
const path = require('path')

const OrderExtractor = require('../src/core/extractor')
const OcrEngine = require('../src/core/extractor/ocr')

const CAPTURE = path.join(
  __dirname, '..', 'tmp', 'qm-dev', 'data', 'captures',
  '2026-05-13T22-16-23-306Z--n1410230.bin'
)
const EXPECTED_ORDER = 1410230

const failures = []
function check (label, ok, detail) {
  if (ok) console.log(`  ok  ${label}`)
  else { console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); failures.push(label) }
}

async function main () {
  if (!fs.existsSync(CAPTURE)) {
    console.error(`capture not found: ${CAPTURE}`)
    console.error('this test depends on the 2026-05-13 OCR session captures; regenerate with debug.dump_raw_payloads=true and a fresh ERPNext print, then update CAPTURE/EXPECTED_ORDER')
    process.exit(2)
  }

  const buf = fs.readFileSync(CAPTURE)

  const extractor = new OrderExtractor({
    regex: 'رقم الطلب:?\\s*#?\\s*(\\d+)',
    ocr: { enabled: true, regex: '#\\s*(\\d{4,})' }
  })
  const ocr = new OcrEngine({})
  extractor.setOcrEngine(ocr)

  const ret = extractor.extract(buf)
  check('extract() returns a thenable', ret && typeof ret.then === 'function',
    `got ${typeof ret}`)

  const result = await ret
  check('extracted=true', result.extracted === true,
    `got ${JSON.stringify({ extracted: result.extracted, method: result.method })}`)
  check(`order_number=${EXPECTED_ORDER}`, result.order_number === EXPECTED_ORDER,
    `got ${result.order_number}`)
  check("method='ocr'", result.method === 'ocr', `got '${result.method}'`)

  const empty = await extractor.extract(Buffer.alloc(0))
  check('empty buffer → method=fallback', empty.method === 'fallback')
  check('empty buffer → extracted=false', empty.extracted === false)

  await ocr.close()

  if (failures.length) {
    console.error(`\n${failures.length} failure(s)`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((err) => {
  console.error('smoke-extractor crashed:', err.stack || err.message)
  process.exit(1)
})
