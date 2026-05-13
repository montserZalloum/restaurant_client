'use strict'

const { EventEmitter } = require('events')
const WebSocket = require('ws')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

const WS_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
const WS_HEARTBEAT_MS = 30000
const WS_DEAD_AFTER_MS = 60000
const STATUS_REPORT_INTERVAL_MS = 30000
const BATCH_INTERVAL_MS = 2000
const BATCH_MAX = 50
const HTTP_BACKOFF_5XX_MAX_MS = 60000
const HTTP_BACKOFF_4XX_MS = 60000
const HTTP_BACKOFF_NETWORK_MS = 2000

function pickBackoff (attempt) {
  return WS_BACKOFF_MS[Math.min(attempt, WS_BACKOFF_MS.length - 1)]
}

class CloudSyncClient extends EventEmitter {
  constructor ({
    config,
    logger,
    syncQueue,
    getStatusSnapshot,
    fetchFn,
    WSClass,
    pkgVersion
  } = {}) {
    super()
    if (!config) throw new Error('CloudSyncClient: config required')
    if (!syncQueue) throw new Error('CloudSyncClient: syncQueue required')
    if (typeof getStatusSnapshot !== 'function') {
      throw new Error('CloudSyncClient: getStatusSnapshot fn required')
    }

    this.config = config
    this.logger = logger || noopLogger
    this.syncQueue = syncQueue
    this.getStatusSnapshot = getStatusSnapshot
    this.fetch = fetchFn || globalThis.fetch
    if (typeof this.fetch !== 'function') {
      throw new Error('CloudSyncClient: fetch is not available (Node 20+ required)')
    }
    this.WS = WSClass || WebSocket
    this.pkgVersion = pkgVersion || '0.0.0'

    this._ws = null
    this._wsAttempt = 0
    this._wsReconnectTimer = null
    this._statusTimer = null
    this._heartbeatTimer = null
    this._lastMessageAt = 0

    this._batchTimer = null
    this._httpAuthStopped = false
    this._httpBackoffMs = BATCH_INTERVAL_MS

    this._stopped = false
    this._started = false
  }

  start () {
    if (this._started) return
    this._started = true
    this._stopped = false
    this._scheduleWsConnect(0)
    this._scheduleBatchFlush(BATCH_INTERVAL_MS)
    this._scheduleStatusTimer()
  }

  async stop () {
    if (this._stopped) return
    this._stopped = true
    this._started = false
    if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer)
    if (this._batchTimer) clearTimeout(this._batchTimer)
    if (this._statusTimer) clearInterval(this._statusTimer)
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
    this._wsReconnectTimer = null
    this._batchTimer = null
    this._statusTimer = null
    this._heartbeatTimer = null
    if (this._ws) {
      try { this._ws.removeAllListeners() } catch { /* best effort */ }
      try { this._ws.close() } catch { /* best effort */ }
      this._ws = null
    }
    this.logger.info('cloud sync client stopped')
  }

  // ──────────────────────────────────────────────────────────
  // WebSocket: persistent inbound channel + status reporting
  // ──────────────────────────────────────────────────────────

  _scheduleWsConnect (delay) {
    if (this._stopped) return
    if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer)
    this._wsReconnectTimer = setTimeout(() => this._connectWs(), delay)
    this._wsReconnectTimer.unref?.()
  }

  _connectWs () {
    if (this._stopped) return
    this._wsReconnectTimer = null

    const url = `${this.config.cloud.ws_url}/local-agent` +
      `?restaurant_id=${encodeURIComponent(this.config.restaurant.id)}` +
      `&api_key=${encodeURIComponent(this.config.restaurant.api_key)}`

    this.logger.debug('cloud WS connecting', { attempt: this._wsAttempt + 1 })

    let ws
    try {
      ws = new this.WS(url, {
        headers: { 'User-Agent': `queue-manager-agent/${this.pkgVersion}` }
      })
    } catch (e) {
      this.logger.warn('cloud WS construct failed', { err: e.message })
      this._scheduleWsReconnectAfterFailure()
      return
    }

    this._ws = ws

    ws.on('open', () => {
      this._wsAttempt = 0
      this._lastMessageAt = Date.now()
      this.logger.info('cloud WS connected')
      this.emit('connected')
      this._sendStatus()
      this._startHeartbeat()
    })

    ws.on('message', (raw) => {
      this._lastMessageAt = Date.now()
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) } catch (e) {
        this.logger.warn('cloud WS: invalid JSON', { err: e.message })
        return
      }
      this._handleInbound(msg)
    })

    ws.on('error', (err) => {
      this.logger.warn('cloud WS error', { err: err.message })
    })

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : ''
      this.logger.warn('cloud WS closed', { code, reason: reason || null })
      this._stopHeartbeat()
      this.emit('disconnected', { code, reason })
      this._ws = null
      this._scheduleWsReconnectAfterFailure()
    })
  }

  _scheduleWsReconnectAfterFailure () {
    const delay = pickBackoff(this._wsAttempt)
    this._wsAttempt += 1
    this.logger.debug(`cloud WS will retry in ${delay}ms`, { attempt: this._wsAttempt })
    this._scheduleWsConnect(delay)
  }

  _handleInbound (msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this.logger.warn('cloud WS: malformed message')
      return
    }
    switch (msg.type) {
      case 'order_event':
        this.emit('order_event', msg)
        break
      case 'clear_screen':
        this.emit('clear_screen', msg)
        break
      case 'settings_updated':
        this.emit('settings_updated', msg)
        break
      case 'ping':
        this._sendRaw({ type: 'pong', at: Date.now() })
        break
      case 'pong':
        // already updated _lastMessageAt
        break
      default:
        this.logger.debug('cloud WS: unknown message type', { type: msg.type })
        this.emit('message', msg)
    }
  }

  _startHeartbeat () {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      const idle = Date.now() - this._lastMessageAt
      if (idle > WS_DEAD_AFTER_MS) {
        this.logger.warn(`cloud WS idle ${idle}ms — reconnecting`)
        try { this._ws && this._ws.terminate() } catch { /* best effort */ }
      }
    }, WS_HEARTBEAT_MS)
    this._heartbeatTimer.unref?.()
  }

  _stopHeartbeat () {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  _scheduleStatusTimer () {
    if (this._statusTimer) clearInterval(this._statusTimer)
    this._statusTimer = setInterval(() => this._sendStatus(), STATUS_REPORT_INTERVAL_MS)
    this._statusTimer.unref?.()
  }

  _sendStatus () {
    if (!this._ws || this._ws.readyState !== this.WS.OPEN) return
    let snapshot
    try { snapshot = this.getStatusSnapshot() } catch (e) {
      this.logger.warn('status snapshot failed', { err: e.message })
      return
    }
    const data = {
      ...snapshot,
      version: this.pkgVersion
    }
    this._sendRaw({ type: 'status', data })
  }

  _sendRaw (obj) {
    if (!this._ws || this._ws.readyState !== this.WS.OPEN) return false
    try {
      this._ws.send(JSON.stringify(obj))
      return true
    } catch (e) {
      this.logger.warn('cloud WS send failed', { err: e.message })
      return false
    }
  }

  // Public: forward a message over the WS channel if connected. Used by
  // index.js to relay printer_status changes to the cloud in real time.
  sendMessage (obj) { return this._sendRaw(obj) }

  // ──────────────────────────────────────────────────────────
  // HTTP: outbound batch sender for sync queue
  // ──────────────────────────────────────────────────────────

  _scheduleBatchFlush (delay) {
    if (this._stopped) return
    if (this._batchTimer) clearTimeout(this._batchTimer)
    this._batchTimer = setTimeout(() => this._flushOnce(), delay)
    this._batchTimer.unref?.()
  }

  async _flushOnce () {
    if (this._stopped) return
    this._batchTimer = null

    if (this._httpAuthStopped) {
      // permanently stopped due to 401 — don't retry until process restart
      return
    }

    const batch = this.syncQueue.peekBatch(BATCH_MAX)
    if (batch.length === 0) {
      this._scheduleBatchFlush(BATCH_INTERVAL_MS)
      return
    }

    const url = `${this.config.cloud.base_url}/api/orders/events`
    let res
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.restaurant.api_key}`
        },
        body: JSON.stringify({ events: batch })
      })
    } catch (e) {
      this.logger.warn('sync POST network error', { err: e.message, count: batch.length })
      this._scheduleBatchFlush(HTTP_BACKOFF_NETWORK_MS)
      return
    }

    if (res.ok) {
      let acceptedIds
      let rejected = []
      try {
        const json = await res.json()
        if (!json || !Array.isArray(json.accepted)) {
          throw new Error('200 response missing accepted[] array')
        }
        acceptedIds = json.accepted
        if (Array.isArray(json.rejected)) rejected = json.rejected
      } catch (e) {
        this.logger.error('sync POST: malformed 200 body — leaving batch in queue', { err: e.message })
        this._scheduleBatchFlush(HTTP_BACKOFF_NETWORK_MS)
        return
      }
      if (rejected.length > 0) {
        this.logger.warn(`sync POST: ${rejected.length} events rejected by cloud`, {
          rejected: rejected.slice(0, 10)
        })
      }
      try {
        const acked = await this.syncQueue.ackBatch(acceptedIds)
        this._httpBackoffMs = BATCH_INTERVAL_MS
        this.logger.debug(`sync POST ok: ${acked} acked, ${rejected.length} rejected, ${this.syncQueue.size()} remaining`)
      } catch (e) {
        this.logger.error('sync queue ack failed', { err: e.message })
      }
      this._scheduleBatchFlush(BATCH_INTERVAL_MS)
      return
    }

    if (res.status === 401) {
      this._httpAuthStopped = true
      this.logger.critical('sync POST 401 — invalid api_key. cloud sync STOPPED.')
      this.emit('http_auth_failed')
      return
    }

    if (res.status >= 500 && res.status < 600) {
      this._httpBackoffMs = Math.min(this._httpBackoffMs * 2, HTTP_BACKOFF_5XX_MAX_MS)
      this.logger.warn(`sync POST 5xx ${res.status} — backing off ${this._httpBackoffMs}ms`)
      this._scheduleBatchFlush(this._httpBackoffMs)
      return
    }

    // 4xx (other than 401): the batch is malformed at the contract level.
    // Drop it instead of re-queuing forever — retrying a structurally invalid
    // batch will never succeed and would block the queue head.
    let bodyText = ''
    try { bodyText = (await res.text()).slice(0, 500) } catch { /* ignored */ }
    this.logger.error(`sync POST ${res.status} — dropping batch (${batch.length} events)`, {
      body: bodyText,
      event_ids: batch.map(e => e.event_id).slice(0, 5)
    })
    try {
      await this.syncQueue.ackBatch(batch.map(e => e.event_id))
    } catch (e) {
      this.logger.error('sync queue drop-on-4xx ack failed', { err: e.message })
    }
    this._scheduleBatchFlush(BATCH_INTERVAL_MS)
  }
}

module.exports = CloudSyncClient
