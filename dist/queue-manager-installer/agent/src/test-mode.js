'use strict'

const net = require('net')
const { EventEmitter } = require('events')
const iconv = require('iconv-lite')

const { loadConfig } = require('./config/loader')
const logger = require('./logging/logger')
const OrderExtractor = require('./core/extractor')
const { createTestModeServer } = require('./server/test-mode-server')

const PKG_VERSION = require('../package.json').version

const ENCODINGS = ['utf-8', 'win1256', 'cp864']
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])

const DIAGNOSTIC_PORT = parseInt(process.env.QM_TEST_MODE_PORT || '9300', 10)
const DIAGNOSTIC_BIND = process.env.QM_TEST_MODE_BIND || '0.0.0.0'

function stripBom (buffer) {
  if (buffer.length >= 3 && buffer.slice(0, 3).equals(UTF8_BOM)) return buffer.slice(3)
  return buffer
}

function decode (buffer, encoding) {
  try {
    if (encoding === 'utf-8') return stripBom(buffer).toString('utf8')
    return iconv.decode(buffer, encoding)
  } catch {
    return null
  }
}

function hexPreview (buffer, max = 100) {
  const slice = buffer.slice(0, max)
  const pairs = []
  for (let i = 0; i < slice.length; i++) {
    pairs.push(slice[i].toString(16).padStart(2, '0').toUpperCase())
  }
  let out = ''
  for (let i = 0; i < pairs.length; i += 16) {
    out += pairs.slice(i, i + 16).join(' ') + '\n'
  }
  if (buffer.length > max) out += `… (+${buffer.length - max} more bytes)\n`
  return out.trimEnd()
}

class TestPrintListener extends EventEmitter {
  constructor ({
    bindAddress = '0.0.0.0',
    bindPort,
    idleTimeoutMs = 500,
    maxBufferBytes = 64 * 1024,
    logger: log
  } = {}) {
    super()
    if (!Number.isInteger(bindPort)) throw new Error('TestPrintListener: bindPort required')
    this.bindAddress = bindAddress
    this.bindPort = bindPort
    this.idleTimeoutMs = idleTimeoutMs
    this.maxBufferBytes = maxBufferBytes
    this.logger = log || { info () {}, warn () {}, debug () {}, error () {} }
    this._server = null
  }

  start () {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this._onConnection(sock))
      srv.once('error', reject)
      srv.listen(this.bindPort, this.bindAddress, () => {
        srv.removeListener('error', reject)
        this._server = srv
        const a = srv.address()
        this.logger.info(`test-mode TCP listening on ${a.address}:${a.port}`)
        resolve()
      })
    })
  }

  stop () {
    return new Promise((resolve) => {
      if (!this._server) return resolve()
      this._server.close(() => resolve())
      this._server = null
    })
  }

  _onConnection (sock) {
    const remoteIp = (sock.remoteAddress || '').replace(/^::ffff:/, '')
    const buffers = []
    let totalBytes = 0
    const startedAt = Date.now()
    let processed = false
    let idleTimer = null

    const finish = (cause) => {
      if (processed) return
      processed = true
      if (idleTimer) clearTimeout(idleTimer)
      const rawData = Buffer.concat(buffers, totalBytes)
      if (rawData.length > 0) {
        try { this.emit('order', { rawData, receivedAt: startedAt, remoteIp, cause }) } catch (e) {
          this.logger.error('test-mode order handler threw', { err: e.message })
        }
      }
      try { sock.end() } catch { /* */ }
    }

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish('idle'), this.idleTimeoutMs)
      idleTimer.unref?.()
    }

    sock.on('data', (chunk) => {
      const remaining = this.maxBufferBytes - totalBytes
      if (remaining <= 0) return
      const usable = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
      buffers.push(usable)
      totalBytes += usable.length
      resetIdle()
    })
    sock.on('end', () => finish('end'))
    sock.on('error', (err) => {
      this.logger.warn('cashier socket error in test-mode', { err: err.message })
      finish('error')
    })
    sock.on('close', () => finish('close'))
    resetIdle()
  }
}

const cleanupTasks = []
let shuttingDown = false

function registerCleanup (fn) { cleanupTasks.push(fn) }

async function shutdown (signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`test-mode received ${signal} — graceful shutdown`)
  for (const task of [...cleanupTasks].reverse()) {
    try { await task() } catch (e) {
      logger.error('test-mode cleanup task failed', { error: e.message })
    }
  }
  logger.info('test-mode stopped')
  logger.close()
  process.exit(code)
}

function buildExtractionResult (rawData, regexSource) {
  if (typeof regexSource !== 'string' || !regexSource) {
    return { regex: null, matched: false, per_encoding: [] }
  }
  let regex
  try { regex = new RegExp(regexSource) } catch (e) {
    return { regex: regexSource, matched: false, error: `invalid regex: ${e.message}`, per_encoding: [] }
  }
  const perEncoding = []
  let firstHit = null
  for (const enc of ENCODINGS) {
    const text = decode(rawData, enc)
    let matched = false
    let order_number = null
    if (text) {
      const m = text.match(regex)
      if (m && m[1]) {
        const num = parseInt(m[1], 10)
        if (Number.isInteger(num) && num > 0) {
          matched = true
          order_number = num
          if (!firstHit) firstHit = { encoding: enc, order_number: num }
        }
      }
    }
    perEncoding.push({ encoding: enc, matched, order_number })
  }
  if (firstHit) {
    return {
      regex: regexSource,
      matched: true,
      matched_encoding: firstHit.encoding,
      order_number: firstHit.order_number,
      per_encoding: perEncoding
    }
  }
  return { regex: regexSource, matched: false, per_encoding: perEncoding }
}

async function main () {
  const args = process.argv.slice(2)
  const checkMode = args.includes('--check')

  let config
  try {
    config = loadConfig()
  } catch (err) {
    process.stderr.write(`[TEST-MODE] Config error:\n${err.message}\n`)
    process.exit(1)
  }

  const platform = require('./platform')
  logger.init(config.logging, platform)
  logger.info(`Test Mode بدء التشغيل — Queue Manager v${PKG_VERSION}`)

  // ── Resolve bind address ─────────────────────────────
  const oldIp = config.network.printer_old_ip
  const port = config.network.printer_port
  const localIps = (typeof platform.getLocalIpAddresses === 'function')
    ? platform.getLocalIpAddresses() : []
  const aliasReady = !!(oldIp && localIps.includes(oldIp))
  const bindAddress = aliasReady ? oldIp : '0.0.0.0'
  if (!aliasReady) {
    logger.warn('printer_old_ip not bound to a local interface — listening on 0.0.0.0', {
      printer_old_ip: oldIp,
      local_ips: localIps
    })
  }

  // ── State ─────────────────────────────────────────────
  const startedAt = Date.now()
  const state = {
    listening: { host: bindAddress, port, alias_ready: aliasReady },
    started_at: startedAt,
    received_count: 0,
    last: null
  }

  // ── HTTP diagnostic server (port 9300) ────────────────
  const httpServer = createTestModeServer({
    logger: logger.child('test-mode-http'),
    getState: () => ({ ...state, last: state.last }),
    clearLast: () => { state.last = null }
  })
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(DIAGNOSTIC_PORT, DIAGNOSTIC_BIND, () => {
      httpServer.removeListener('error', reject)
      const a = httpServer.address()
      logger.info(`test-mode diagnostic HTTP on http://${a.address}:${a.port}`)
      resolve()
    })
  })
  registerCleanup(async () => { await new Promise(r => httpServer.close(() => r())) })

  // ── TCP listener (no forwarding) ──────────────────────
  const listener = new TestPrintListener({
    bindAddress,
    bindPort: port,
    logger: logger.child('test-mode-tcp')
  })
  await listener.start()
  registerCleanup(async () => { await listener.stop() })

  // Build a logger-bound extractor for parity with main agent extraction
  const extractor = new OrderExtractor({
    regex: config.extractor.regex,
    logger: logger.child('test-mode-extractor')
  })

  listener.on('order', async ({ rawData, receivedAt, remoteIp }) => {
    state.received_count += 1

    // Decode in all encodings for the diagnostic page
    const decoded = {}
    for (const enc of ENCODINGS) {
      decoded[enc] = decode(rawData, enc)
    }

    // Run agent's extractor (single result) for parity with prod
    let agentExtraction
    try {
      const r = await extractor.extract(rawData)
      agentExtraction = {
        order_number: r.order_number,
        extracted: r.extracted,
        encoding: r.encoding,
        method: r.method
      }
    } catch (e) {
      agentExtraction = { error: e.message }
    }

    // Plus per-encoding diagnostic (regardless of agent's pick)
    const perEncodingResult = buildExtractionResult(rawData, config.extractor.regex)
    perEncodingResult.rule_id = config.extractor.rule_id || null
    perEncodingResult.agent = agentExtraction

    state.last = {
      received_at: receivedAt,
      bytes: rawData.length,
      remote_ip: remoteIp || null,
      hex_preview: hexPreview(rawData),
      decoded,
      extraction: perEncodingResult
    }

    logger.info(
      `test-mode received print (${rawData.length}B from ${remoteIp || '?'}) — agent_extracted=${agentExtraction.extracted}` +
      (agentExtraction.extracted ? ` order=${agentExtraction.order_number} enc=${agentExtraction.encoding}` : '')
    )
  })

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    logger.critical('test-mode uncaught', { error: err.message, stack: err.stack })
    shutdown('uncaughtException', 1)
  })

  process.stdout.write(
    '\n=================================================\n' +
    '  Queue Manager — Test Mode\n' +
    '=================================================\n' +
    `  TCP   ${bindAddress}:${port}  ${aliasReady ? '(alias ready)' : '(NO alias — bind 0.0.0.0)'}\n` +
    `  HTTP  http://localhost:${DIAGNOSTIC_PORT}\n` +
    '\n  Press Ctrl+C to stop.\n' +
    '=================================================\n\n'
  )

  if (checkMode) {
    logger.info('--check mode: exiting after successful test-mode startup')
    await shutdown('--check', 0)
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[TEST-MODE] unhandled: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}

module.exports = { main, TestPrintListener, hexPreview, buildExtractionResult }
