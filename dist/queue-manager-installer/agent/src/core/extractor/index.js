'use strict'

const iconv = require('iconv-lite')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

const ENCODINGS = ['utf-8', 'win1256', 'cp864']

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])

function stripBom (buffer) {
  if (buffer.length >= 3 && buffer.slice(0, 3).equals(UTF8_BOM)) {
    return buffer.slice(3)
  }
  return buffer
}

function decodeBuffer (buffer, encoding) {
  if (encoding === 'utf-8') return stripBom(buffer).toString('utf8')
  return iconv.decode(buffer, encoding)
}

class OrderExtractor {
  constructor ({ regex, logger, initialFallbackSerial = 0 } = {}) {
    if (typeof regex !== 'string' || !regex) {
      throw new Error('OrderExtractor: regex (string) is required')
    }
    this.logger = logger || noopLogger
    this._setRegex(regex)
    this._fallbackSerial = Number.isInteger(initialFallbackSerial) ? initialFallbackSerial : 0
  }

  _setRegex (source) {
    this._regexSource = source
    this._regex = new RegExp(source)
  }

  setRegex (source) {
    if (typeof source !== 'string' || !source) {
      throw new Error('OrderExtractor.setRegex: regex string required')
    }
    let next
    try { next = new RegExp(source) } catch (e) {
      throw new Error(`OrderExtractor.setRegex: invalid regex: ${e.message}`)
    }
    this._regexSource = source
    this._regex = next
    this.logger.info('extractor regex updated', { regex: source })
  }

  /**
   * Extract order number from raw print payload.
   * @param {Buffer} buffer Raw bytes received from the cashier.
   * @returns {{order_number:number, extracted:boolean, encoding:string|null, text:string|null}}
   */
  extract (buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return this._fallback(null, null)
    }

    for (const enc of ENCODINGS) {
      let text
      try {
        text = decodeBuffer(buffer, enc)
      } catch (e) {
        this.logger.debug('decode failed', { encoding: enc, err: e.message })
        continue
      }
      if (!text) continue

      const match = text.match(this._regex)
      if (match && match[1]) {
        const num = parseInt(match[1], 10)
        if (Number.isInteger(num) && num > 0) {
          return { order_number: num, extracted: true, encoding: enc, text }
        }
      }
    }

    let bestText = null
    try { bestText = decodeBuffer(buffer, 'utf-8') } catch { /* ignored */ }
    return this._fallback(bestText, null)
  }

  _fallback (text, encoding) {
    this._fallbackSerial += 1
    this.logger.warn('order number extraction failed — using local serial', {
      serial: this._fallbackSerial,
      text_preview: typeof text === 'string' ? text.slice(0, 80) : null
    })
    return {
      order_number: this._fallbackSerial,
      extracted: false,
      encoding,
      text
    }
  }
}

module.exports = OrderExtractor
module.exports.ENCODINGS = ENCODINGS
