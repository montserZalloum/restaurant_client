'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')

const STATIC_DIR = path.join(__dirname, 'static')

const ENV_PLACEHOLDER = '__QM_ENV_JSON__'
const MAX_BODY_BYTES = 4 * 1024  // tiny: only PIN login bodies

const STATIC_ASSETS = {
  '/staff/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/staff/app.js':     { file: 'app.js',     type: 'application/javascript; charset=utf-8' }
}

const INDEX_ROUTES = new Set(['/staff', '/staff/', '/staff/index.html'])

function loadStatic () {
  const cache = { __index_template: null }
  for (const [route, meta] of Object.entries(STATIC_ASSETS)) {
    const fullPath = path.join(STATIC_DIR, meta.file)
    try {
      cache[route] = { body: fs.readFileSync(fullPath), type: meta.type }
    } catch {
      cache[route] = null
    }
  }
  try {
    cache.__index_template = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8')
  } catch {
    cache.__index_template = null
  }
  return cache
}

function renderIndex (template, env) {
  const json = JSON.stringify(env || {})
    .replace(/</g, '\\u003c')  // safe inside <script>
  return template.replace(ENV_PLACEHOLDER, json)
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch (e) { reject(new Error('invalid_json')) }
    })
  })
}

function sendJson (res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function getStaffPinFromRequest (req, url) {
  return (req.headers['x-staff-pin'] || url.searchParams.get('pin') || '').toString()
}

function makeRequestHandler (deps) {
  const {
    logger, staticCache, startedAt,
    getActiveCount, getPrinterStatus,
    getEnv, getStaffPin, getActiveOrders
  } = deps

  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    try {
      // ── Login ────────────────────────────────────
      if (pathname === '/api/local/login') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed' })
        }
        let body
        try { body = await readJsonBody(req) } catch (e) {
          return sendJson(res, 400, { error: e.message || 'bad_request' })
        }
        const pin = (body && body.pin) ? String(body.pin) : ''
        const expected = getStaffPin()
        if (!pin || !expected || pin !== expected) {
          return sendJson(res, 401, { valid: false, error: 'invalid_credentials' })
        }
        return sendJson(res, 200, { valid: true })
      }

      // ── Active orders (PIN-protected, parity with cloud /api/staff/active-orders) ─
      if (pathname === '/api/local/active-orders') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'method_not_allowed' })
        }
        const expected = getStaffPin()
        const provided = getStaffPinFromRequest(req, url)
        if (!provided || provided !== expected) {
          return sendJson(res, 401, { error: 'invalid_credentials' })
        }
        const orders = typeof getActiveOrders === 'function' ? getActiveOrders() : []
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end()
          return
        }
        return sendJson(res, 200, { orders })
      }

      // ── Health ─────────────────────────────────
      if (pathname === '/api/local/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'method_not_allowed' })
        }
        const body = {
          status: 'ok',
          uptime: Math.round((Date.now() - startedAt) / 1000),
          active_orders: typeof getActiveCount === 'function' ? getActiveCount() : null,
          printer: typeof getPrinterStatus === 'function' ? getPrinterStatus() : null
        }
        return sendJson(res, 200, body)
      }

      // ── Static / index template ────────────────
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' }).end('method not allowed')
        return
      }

      if (INDEX_ROUTES.has(pathname)) {
        const tpl = staticCache.__index_template
        if (!tpl) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('index template missing')
          return
        }
        const env = typeof getEnv === 'function' ? (getEnv() || {}) : {}
        const html = renderIndex(tpl, env)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        if (req.method === 'HEAD') return res.end()
        return res.end(html)
      }

      const entry = staticCache[pathname]
      if (entry) {
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Cache-Control': 'no-store'
        })
        if (req.method === 'HEAD') return res.end()
        return res.end(entry.body)
      }

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(302, { Location: '/staff' }).end()
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
    } catch (e) {
      if (logger && logger.warn) logger.warn('http handler error', { err: e.message })
      try { res.writeHead(500, { 'Content-Type': 'text/plain' }).end('internal error') } catch { /* */ }
    }
  }
}

function createHttpServer (deps) {
  const handler = makeRequestHandler(deps)
  return http.createServer(handler)
}

module.exports = {
  createHttpServer,
  loadStatic,
  renderIndex,
  STATIC_DIR,
  ENV_PLACEHOLDER
}
