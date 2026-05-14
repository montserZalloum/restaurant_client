'use strict'

const fs = require('fs')
const path = require('path')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

const BUNDLED_TESSDATA_DIR = path.join(__dirname, 'tessdata')

function findBundledTessdata (lang) {
  // Tesseract.js looks for `{lang}.traineddata.gz` at langPath when cacheMethod='none'.
  const candidate = path.join(BUNDLED_TESSDATA_DIR, `${lang}.traineddata.gz`)
  return fs.existsSync(candidate) ? BUNDLED_TESSDATA_DIR : null
}

/**
 * Long-lived Tesseract.js worker wrapper.
 *
 * Tessdata strategy:
 *   - If src/core/extractor/tessdata/{lang}.traineddata exists (populated by
 *     `npm run vendor`), the worker reads from there with cacheMethod='none'
 *     so it never touches the CDN — usable offline.
 *   - Otherwise it falls back to Tesseract.js defaults (downloads from CDN
 *     on first use, caches under the user's temp dir). Useful in dev when
 *     vendor hasn't been run yet.
 */
class OcrEngine {
  constructor ({ logger, lang = 'eng', charWhitelist = '0123456789#:/ .-' } = {}) {
    this.logger = logger || noopLogger
    this.lang = lang
    this.charWhitelist = charWhitelist
    this._worker = null
    this._initPromise = null
  }

  async _ensureWorker () {
    if (this._worker) return this._worker
    if (this._initPromise) return this._initPromise

    this._initPromise = (async () => {
      const { createWorker } = require('tesseract.js')
      const langPath = findBundledTessdata(this.lang)
      this.logger.info('initializing OCR worker', {
        lang: this.lang,
        source: langPath ? 'bundled' : 'CDN (no bundled tessdata found — run "npm run vendor")'
      })
      const t0 = Date.now()
      const workerOptions = {}
      if (langPath) {
        workerOptions.langPath = langPath
        workerOptions.cacheMethod = 'none'
      }
      const worker = await createWorker(this.lang, 1, workerOptions)
      await worker.setParameters({ tessedit_char_whitelist: this.charWhitelist })
      this._worker = worker
      this.logger.info('OCR worker ready', { ms: Date.now() - t0 })
      return worker
    })().catch((err) => {
      this._initPromise = null
      throw err
    })

    return this._initPromise
  }

  async recognize (pngBuffer) {
    const worker = await this._ensureWorker()
    const t0 = Date.now()
    const { data } = await worker.recognize(pngBuffer)
    return {
      text: data.text || '',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      ms: Date.now() - t0
    }
  }

  async close () {
    if (!this._worker) return
    const w = this._worker
    this._worker = null
    this._initPromise = null
    try { await w.terminate() } catch { /* best effort */ }
  }
}

module.exports = OcrEngine
