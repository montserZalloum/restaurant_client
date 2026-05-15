'use strict'

const net = require('net')
const { EventEmitter } = require('events')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

function normalizeIp (ip) {
  if (typeof ip !== 'string') return ip
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length)
  return ip
}

class PrintInterceptor extends EventEmitter {
  constructor ({
    bindAddress = '0.0.0.0',
    bindPort,
    cashierIp,
    targetHost,
    targetPort,
    maxBufferBytes = 512 * 1024,
    idleTimeoutMs = 500,
    retryDelayMs = 200,
    maxRetries = 3,
    allowLoopback = true,
    logger
  } = {}) {
    super()
    if (!Number.isInteger(bindPort)) throw new Error('PrintInterceptor: bindPort required')
    if (!targetHost) throw new Error('PrintInterceptor: targetHost required')
    if (!Number.isInteger(targetPort)) throw new Error('PrintInterceptor: targetPort required')

    this.bindAddress = bindAddress
    this.bindPort = bindPort
    this.cashierIp = cashierIp || null
    this.targetHost = targetHost
    this.targetPort = targetPort
    this.maxBufferBytes = maxBufferBytes
    this.idleTimeoutMs = idleTimeoutMs
    this.retryDelayMs = retryDelayMs
    this.maxRetries = maxRetries
    this.allowLoopback = allowLoopback
    this.logger = logger || noopLogger

    this._server = null
    this._printerStatus = 'unknown'  // unknown | ok | failed
    this._printerStatusSince = Date.now()
    this._activeSessions = new Set()
  }

  start () {
    if (this._server) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this._onCashierConnection(sock))
      srv.on('error', (err) => {
        if (!this._server) {
          // initial listen failed
          reject(err)
        } else {
          this.logger.error('interceptor server error', { err: err.message })
        }
      })
      srv.listen(this.bindPort, this.bindAddress, () => {
        this._server = srv
        const addr = srv.address()
        this.logger.info(`print interceptor listening on ${addr.address}:${addr.port}`, {
          target: `${this.targetHost}:${this.targetPort}`,
          cashier_ip: this.cashierIp
        })
        resolve()
      })
    })
  }

  async stop () {
    if (!this._server) return
    const srv = this._server
    this._server = null
    for (const session of [...this._activeSessions]) {
      try { session.cashierSock.destroy() } catch { /* best effort */ }
      if (session.printerSock) {
        try { session.printerSock.destroy() } catch { /* best effort */ }
      }
    }
    this._activeSessions.clear()
    await new Promise((resolve) => {
      srv.close(() => resolve())
      setTimeout(resolve, 500).unref?.()
    })
    this.logger.info('print interceptor stopped')
  }

  getPrinterStatus () {
    return { status: this._printerStatus, since: this._printerStatusSince }
  }

  _setPrinterStatus (status, reason) {
    if (this._printerStatus === status) return
    this._printerStatus = status
    this._printerStatusSince = Date.now()
    this.logger.info(`printer status: ${status}`, reason ? { reason } : undefined)
    this.emit('printer_status', { status, since: this._printerStatusSince, reason: reason || null })
  }

  _isCashierAllowed (remoteIp) {
    const ip = normalizeIp(remoteIp)
    if (this.allowLoopback && (ip === '127.0.0.1' || ip === '::1')) return true
    if (!this.cashierIp) return false
    return ip === this.cashierIp
  }

  _onCashierConnection (cashierSock) {
    const remoteIp = normalizeIp(cashierSock.remoteAddress)
    if (!this._isCashierAllowed(cashierSock.remoteAddress)) {
      this.logger.warn('rejected non-cashier TCP connection', { ip: remoteIp })
      try { cashierSock.destroy() } catch { /* best effort */ }
      return
    }

    const session = {
      cashierSock,
      printerSock: null,
      printerState: 'connecting', // connecting | connected | failed
      pendingForPrinter: [],
      buffers: [],
      totalBytes: 0,
      idleTimer: null,
      processed: false,
      startedAt: Date.now(),
      remoteIp
    }
    this._activeSessions.add(session)

    this.logger.debug('cashier connected', { ip: remoteIp })

    this._connectToPrinter(session, 1)

    cashierSock.setNoDelay(true)
    cashierSock.on('data', (chunk) => this._onCashierData(session, chunk))
    cashierSock.on('end', () => this._processOrder(session, 'end'))
    cashierSock.on('error', (err) => {
      this.logger.warn('cashier socket error', { err: err.message })
      this._processOrder(session, 'error')
    })
    cashierSock.on('close', () => this._processOrder(session, 'close'))

    this._resetIdleTimer(session)
  }

  _onCashierData (session, chunk) {
    if (session.processed) return

    // Forward the FULL chunk to the printer — the maxBufferBytes cap below
    // only bounds our in-memory extraction buffer (for regex/OCR), not what
    // the printer receives. A large raster receipt (>64 KB) used to be
    // silently truncated on the forward pipe too, so the printer got an
    // incomplete bitmap with no cut command and never produced paper.
    if (session.printerState === 'connected') {
      try { session.printerSock.write(chunk) } catch (e) {
        this.logger.warn('write to printer failed mid-stream', { err: e.message })
      }
    } else if (session.printerState === 'connecting') {
      session.pendingForPrinter.push(chunk)
    }
    // if failed: drop the chunk for forwarding (still buffered for extraction)

    // Append to the extraction buffer up to the cap; drop the overflow.
    const remaining = this.maxBufferBytes - session.totalBytes
    if (remaining > 0) {
      const usable = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
      session.buffers.push(usable)
      session.totalBytes += usable.length
      if (chunk.length > remaining && !session.extractionCapWarned) {
        session.extractionCapWarned = true
        this.logger.warn('extraction buffer cap reached — extra payload bytes still forwarded to printer but not used for extraction', {
          max: this.maxBufferBytes
        })
      }
    } else if (!session.extractionCapWarned) {
      session.extractionCapWarned = true
      this.logger.warn('extraction buffer cap reached — extra payload bytes still forwarded to printer but not used for extraction', {
        max: this.maxBufferBytes
      })
    }

    this._resetIdleTimer(session)
  }

  _resetIdleTimer (session) {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      this._processOrder(session, 'idle')
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  _processOrder (session, cause) {
    if (session.processed) return
    session.processed = true
    if (session.idleTimer) clearTimeout(session.idleTimer)
    this._activeSessions.delete(session)

    const rawData = Buffer.concat(session.buffers, session.totalBytes)
    this.logger.debug('processing intercepted order', {
      cause, bytes: rawData.length, ms_elapsed: Date.now() - session.startedAt
    })

    if (rawData.length > 0) {
      try {
        this.emit('order', {
          rawData,
          receivedAt: session.startedAt,
          cause
        })
      } catch (e) {
        this.logger.error('order handler threw', { err: e.message, stack: e.stack })
      }
    }

    try { session.cashierSock.end() } catch { /* best effort */ }
    if (session.printerSock) {
      try { session.printerSock.end() } catch { /* best effort */ }
    }
  }

  _connectToPrinter (session, attempt) {
    if (session.processed) return
    const sock = net.createConnection({
      host: this.targetHost,
      port: this.targetPort,
      family: 4
    })
    let settled = false

    const onConnectError = (err) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* best effort */ }

      if (session.processed) return

      if (attempt < this.maxRetries) {
        this.logger.debug(`printer connect attempt ${attempt} failed — retrying`, {
          err: err.message, target: `${this.targetHost}:${this.targetPort}`
        })
        setTimeout(() => this._connectToPrinter(session, attempt + 1), this.retryDelayMs)
      } else {
        this.logger.error('printer forwarding failed after retries', {
          target: `${this.targetHost}:${this.targetPort}`,
          attempts: this.maxRetries,
          err: err.message
        })
        session.printerState = 'failed'
        session.pendingForPrinter = []
        this._setPrinterStatus('failed', `connect failed: ${err.message}`)
      }
    }

    sock.once('connect', () => {
      if (settled) return
      settled = true
      sock.setNoDelay(true)

      // Flush buffered bytes to the printer regardless of whether the cashier
      // session was already idle-timed-out and processed for extraction. A
      // slow printer connect (sleep mode, ARP cache miss, ~1s wake-up) can
      // race past our 500ms idle timeout — order gets extracted + published
      // correctly, but the paper would never come out because we'd close the
      // socket without flushing. Discovered 2026-05-14 after migrating to the
      // installed service.
      if (session.pendingForPrinter.length > 0) {
        let flushOk = true
        for (const chunk of session.pendingForPrinter) {
          try { sock.write(chunk) } catch (e) {
            this.logger.warn('flush to printer failed', { err: e.message })
            flushOk = false
            break
          }
        }
        session.pendingForPrinter = []
        if (flushOk && session.processed) {
          this.logger.info('printer connect won after extraction — flushed buffered bytes')
        }
      }

      if (this._printerStatus !== 'ok') {
        this._setPrinterStatus('ok')
      }

      if (session.processed) {
        try { sock.end() } catch { /* best effort */ }
        return
      }

      session.printerSock = sock
      session.printerState = 'connected'

      sock.on('error', (err) => {
        this.logger.warn('printer socket error after connect', { err: err.message })
      })
    })

    sock.once('error', onConnectError)
  }
}

module.exports = PrintInterceptor
