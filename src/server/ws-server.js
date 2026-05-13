'use strict'

const { EventEmitter } = require('events')
const { WebSocketServer } = require('ws')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

const HEARTBEAT_MS = 30000
const DEAD_AFTER_MS = 60000

const CLOSE_INVALID_PIN = 4001
const CLOSE_PIN_CHANGED = 4002

function rejectUpgrade (socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`)
  } catch { /* best effort */ }
  try { socket.destroy() } catch { /* best effort */ }
}

class StaffWebSocketServer extends EventEmitter {
  constructor ({
    httpServer,
    staffPin,
    logger
  } = {}) {
    super()
    if (!httpServer) throw new Error('StaffWebSocketServer: httpServer required')
    if (typeof staffPin !== 'string' || !staffPin) {
      throw new Error('StaffWebSocketServer: staffPin required')
    }
    this.httpServer = httpServer
    this.staffPin = staffPin
    this.logger = logger || noopLogger

    this._wss = new WebSocketServer({ noServer: true })
    this._heartbeatTimer = null
    this._upgradeHandler = (req, socket, head) => this._onUpgrade(req, socket, head)

    httpServer.on('upgrade', this._upgradeHandler)

    this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS)
    this._heartbeatTimer.unref?.()
  }

  setStaffPin (newPin, opts = {}) {
    if (typeof newPin !== 'string' || !newPin) return
    if (newPin === this.staffPin) return
    this.staffPin = newPin
    if (opts.kickClients !== false) this._kickAllClients(CLOSE_PIN_CHANGED, 'pin_changed')
  }

  _kickAllClients (code, type) {
    let n = 0
    for (const ws of this._wss.clients) {
      try {
        ws.send(JSON.stringify({ type, at: Date.now() }))
        ws.close(code, type)
      } catch { /* best effort */ }
      n++
    }
    if (n > 0) this.logger.info(`kicked ${n} staff client(s)`, { reason: type })
  }

  close () {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
    this._heartbeatTimer = null
    try { this.httpServer.removeListener('upgrade', this._upgradeHandler) } catch { /* */ }
    for (const ws of this._wss.clients) {
      try { ws.terminate() } catch { /* best effort */ }
    }
    this._wss.close()
  }

  getClientCount () {
    return this._wss.clients.size
  }

  // Broadcast a structured message to every connected staff client.
  broadcast (message) {
    const payload = JSON.stringify(message)
    for (const ws of this._wss.clients) {
      if (ws.readyState !== ws.OPEN) continue
      try { ws.send(payload) } catch (e) {
        this.logger.warn('staff broadcast: send failed', { err: e.message })
      }
    }
  }

  _onUpgrade (req, socket, head) {
    let url
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`) } catch {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }
    if (url.pathname !== '/staff') {
      return rejectUpgrade(socket, 404, 'Not Found')
    }
    const pin = url.searchParams.get('pin')
    if (!pin || pin !== this.staffPin) {
      this.logger.warn('staff WS upgrade rejected: invalid PIN', {
        ip: req.socket.remoteAddress
      })
      return rejectUpgrade(socket, 401, 'Unauthorized')
    }

    this._wss.handleUpgrade(req, socket, head, (ws) => {
      this._onConnect(ws, req)
    })
  }

  _onConnect (ws, req) {
    ws._qm_alive = true
    ws._qm_ip = req.socket.remoteAddress
    ws._qm_lastSeen = Date.now()

    this.logger.info('staff connected', { ip: ws._qm_ip })
    this.emit('staff_connected', { ws })

    ws.on('pong', () => { ws._qm_alive = true; ws._qm_lastSeen = Date.now() })

    ws.on('message', (raw) => {
      ws._qm_lastSeen = Date.now()
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) } catch (e) {
        this._sendError(ws, 'invalid_json', e.message)
        return
      }
      this._onMessage(ws, msg)
    })

    ws.on('error', (err) => {
      this.logger.warn('staff WS error', { err: err.message, ip: ws._qm_ip })
    })

    ws.on('close', () => {
      this.logger.info('staff disconnected', { ip: ws._qm_ip })
      this.emit('staff_disconnected', { ws })
    })
  }

  _onMessage (ws, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this._sendError(ws, 'malformed_message')
      return
    }
    switch (msg.type) {
      case 'order_command': {
        if (msg.data && msg.data.pin && msg.data.pin !== this.staffPin) {
          this._sendError(ws, 'invalid_pin')
          return
        }
        this.emit('order_command', { ws, data: msg.data || {} })
        break
      }
      case 'clear_screen': {
        if (msg.data && msg.data.pin && msg.data.pin !== this.staffPin) {
          this._sendError(ws, 'invalid_pin')
          return
        }
        this.emit('clear_screen', { ws, data: msg.data || {} })
        break
      }
      case 'ping':
        this._sendTo(ws, { type: 'pong', at: Date.now() })
        break
      case 'pong':
        break
      default:
        this.logger.debug('staff WS: unknown message type', { type: msg.type })
        this.emit('message', { ws, msg })
    }
  }

  _sendTo (ws, obj) {
    if (ws.readyState !== ws.OPEN) return false
    try { ws.send(JSON.stringify(obj)); return true } catch (e) {
      this.logger.warn('staff WS send failed', { err: e.message })
      return false
    }
  }

  _sendError (ws, error, detail) {
    this._sendTo(ws, { type: 'error', error, detail: detail || null, at: Date.now() })
  }

  _heartbeat () {
    const now = Date.now()
    for (const ws of this._wss.clients) {
      if (now - (ws._qm_lastSeen || 0) > DEAD_AFTER_MS) {
        this.logger.info('staff WS timeout — terminating', { ip: ws._qm_ip })
        try { ws.terminate() } catch { /* best effort */ }
        continue
      }
      try { ws.ping() } catch { /* best effort */ }
    }
  }
}

module.exports = StaffWebSocketServer
module.exports.CLOSE_INVALID_PIN = CLOSE_INVALID_PIN
module.exports.CLOSE_PIN_CHANGED = CLOSE_PIN_CHANGED
