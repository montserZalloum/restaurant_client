'use strict'

const fs = require('fs')
const path = require('path')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

const BUNDLED_TESSDATA_DIR = path.join(__dirname, 'tessdata')

function bundledTessdataPath (lang) {
  return path.join(BUNDLED_TESSDATA_DIR, `${lang}.traineddata.gz`)
}

function findBundledTessdata (lang) {
  // Tesseract.js looks for `{lang}.traineddata.gz` at langPath when cacheMethod='none'.
  return fs.existsSync(bundledTessdataPath(lang)) ? BUNDLED_TESSDATA_DIR : null
}

/**
 * Long-lived Tesseract.js worker wrapper.
 *
 * Tessdata strategy:
 *   - Bundled tessdata at src/core/extractor/tessdata/{lang}.traineddata.gz is
 *     the only supported source in production. It is checked into the repo
 *     and copied into the installer payload by scripts/package.js.
 *   - If the bundled file is missing AND allowCdnFallback is true, the worker
 *     falls back to Tesseract.js defaults (CDN download, temp-dir cache).
 *     This is intended for dev only — set extractor.ocr.allow_cdn_fallback
 *     in config to opt in. The default is to refuse and throw.
 */
class OcrEngine {
  constructor ({ logger, lang = 'eng', charWhitelist = '0123456789#:/ .-', allowCdnFallback = false } = {}) {
    this.logger = logger || noopLogger
    this.lang = lang
    this.charWhitelist = charWhitelist
    this.allowCdnFallback = !!allowCdnFallback
    this._worker = null
    this._initPromise = null
  }

  static hasBundledTessdata (lang = 'eng') {
    return fs.existsSync(bundledTessdataPath(lang))
  }

  static bundledTessdataPath (lang = 'eng') {
    return bundledTessdataPath(lang)
  }

  async _ensureWorker () {
    if (this._worker) return this._worker
    if (this._initPromise) return this._initPromise

    this._initPromise = (async () => {
      const { createWorker } = require('tesseract.js')
      const langPath = findBundledTessdata(this.lang)
      if (!langPath && !this.allowCdnFallback) {
        throw new Error(
          `OCR worker init refused: bundled tessdata not found at ${bundledTessdataPath(this.lang)}. ` +
          `The file is expected to be checked into the repo; if it is missing, run "npm run vendor" to fetch it. ` +
          `To opt into Tesseract.js CDN download (dev only), set extractor.ocr.allow_cdn_fallback: true in config.`
        )
      }
      this.logger.info('initializing OCR worker', {
        lang: this.lang,
        source: langPath ? 'bundled' : 'CDN (allow_cdn_fallback=true; dev mode)'
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
