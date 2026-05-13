'use strict'

const fs = require('fs')
const fsp = require('fs').promises
const path = require('path')
const net = require('net')
const http = require('http')
const https = require('https')

async function checkPathWritable (dir) {
  try {
    await fsp.mkdir(dir, { recursive: true })
    const probe = path.join(dir, '.qm-health-probe')
    await fsp.writeFile(probe, '', 'utf8')
    await fsp.unlink(probe)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.code || e.message }
  }
}

async function ensureJsonlFile (filePath) {
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    if (!fs.existsSync(filePath)) {
      await fsp.writeFile(filePath, '', 'utf8')
    } else {
      await fsp.readFile(filePath, 'utf8')
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.code || e.message }
  }
}

function checkPortAvailable (port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve({ ok: false, reason: err.code || err.message }))
    server.once('listening', () => server.close(() => resolve({ ok: true })))
    server.listen(port, host || '0.0.0.0')
  })
}

function checkTcpConnection (host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok, reason) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok ? { ok: true } : { ok: false, reason })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('error', (err) => finish(false, err.code || err.message))
    sock.once('timeout', () => finish(false, 'TIMEOUT'))
    sock.connect(port, host)
  })
}

function checkHttpReachable (urlString, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let url
    try { url = new URL(urlString) } catch { return resolve({ ok: false, reason: 'invalid URL' }) }
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        method: 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname || '/',
        timeout: timeoutMs
      },
      (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }) }
    )
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'TIMEOUT' }) })
    req.end()
  })
}

async function runHealthChecks (config, platform) {
  const dataDir = platform.getDataDir()
  const logDir = platform.getLogDir()
  const configDir = platform.getConfigDir()

  const checks = {
    config: { ok: true, file: config.__file || '<resolved>' },
    paths: {},
    jsonl: {},
    cloud: null,
    printer: null,
    ws_port: null,
    http_port: null
  }
  const errors = []
  const warnings = []

  for (const [name, dir] of [['data', dataDir], ['logs', logDir], ['config', configDir]]) {
    const r = await checkPathWritable(dir)
    checks.paths[name] = { dir, ...r }
    if (!r.ok) errors.push(`path '${name}' not writable: ${dir} — ${r.reason}`)
  }

  const activeOrdersPath = path.join(dataDir, 'active_orders.jsonl')
  const syncQueuePath = path.join(dataDir, 'sync_queue.jsonl')
  for (const [name, p] of [['active_orders', activeOrdersPath], ['sync_queue', syncQueuePath]]) {
    const r = await ensureJsonlFile(p)
    checks.jsonl[name] = { path: p, ...r }
    if (!r.ok) warnings.push(`jsonl '${name}' init failed: ${p} — ${r.reason}`)
  }

  if (config.cloud && config.cloud.base_url) {
    const r = await checkHttpReachable(config.cloud.base_url, 3000)
    checks.cloud = { url: config.cloud.base_url, ...r }
    if (!r.ok) warnings.push(`cloud not reachable: ${config.cloud.base_url} — ${r.reason}`)
  }

  if (config.network && config.network.printer_new_ip && config.network.printer_port) {
    const r = await checkTcpConnection(config.network.printer_new_ip, config.network.printer_port, 1500)
    checks.printer = { host: `${config.network.printer_new_ip}:${config.network.printer_port}`, ...r }
    if (!r.ok) warnings.push(`printer not reachable: ${checks.printer.host} — ${r.reason}`)
  }

  const wsPort = config.local_server.websocket_port
  const httpPort = config.local_server.http_port
  const bindAddr = config.local_server.bind_address || '0.0.0.0'
  checks.ws_port = { port: wsPort, ...(await checkPortAvailable(wsPort, bindAddr)) }
  if (!checks.ws_port.ok) errors.push(`local WebSocket port unavailable: ${wsPort} — ${checks.ws_port.reason}`)

  if (httpPort && httpPort !== wsPort) {
    checks.http_port = { port: httpPort, ...(await checkPortAvailable(httpPort, bindAddr)) }
    if (!checks.http_port.ok) errors.push(`local HTTP port unavailable: ${httpPort} — ${checks.http_port.reason}`)
  }

  return { ok: errors.length === 0, errors, warnings, checks }
}

function printBanner (config, platform, healthResult, opts = {}) {
  const c = healthResult.checks
  const activeCount = Number.isInteger(opts.activeCount) ? opts.activeCount : 0
  const wsPort = config.local_server.websocket_port
  const bindAddr = config.local_server.bind_address || '0.0.0.0'
  const cashierPort = (config.network && config.network.printer_port) || '?'

  let lan = []
  try { lan = platform.getLocalIpAddresses() } catch { /* ignore */ }
  const lanStr = lan.length ? lan.join(', ') : '(لا يوجد)'

  const sym = (ok, warnOnly = false) => (ok ? '✓' : (warnOnly ? '⚠' : '✗'))

  const lines = [
    '═══════════════════════════════════════════════',
    'Queue Manager - بدء التشغيل',
    '═══════════════════════════════════════════════',
    `${sym(c.config.ok)} ملف الإعدادات: ${c.config.ok ? 'صحيح' : 'فشل'}`,
    `${sym(c.paths.data && c.paths.data.ok)} مجلد البيانات: ${c.paths.data ? c.paths.data.dir : '?'}`,
    `${sym(c.jsonl.active_orders && c.jsonl.active_orders.ok, true)} ملفات التخزين: ${activeCount} طلب نشط`,
    `${sym(c.cloud && c.cloud.ok, true)} السحابة: ${c.cloud && c.cloud.ok ? 'متصل' : 'غير متصل'}`,
    `${sym(c.printer && c.printer.ok, true)} الطابعة: ${c.printer && c.printer.ok ? 'متصل' : 'غير متصل'}`,
    `${sym(c.ws_port.ok)} بورت WebSocket المحلي ${wsPort}: ${c.ws_port.ok ? 'متاح' : 'غير متاح'}`,
    '═══════════════════════════════════════════════',
    'الخدمة جاهزة. تستمع على:',
    `  - ${bindAddr}:${cashierPort} (طلبات الكاشير)`,
    `  - ${bindAddr}:${wsPort} (WebSocket للموظف)`,
    `LAN IP المُعلَن للسحابة: ${lanStr}`,
    '═══════════════════════════════════════════════'
  ]
  for (const line of lines) process.stdout.write(line + '\n')
}

module.exports = {
  runHealthChecks,
  printBanner,
  // exposed for tests / future health endpoints
  checkPathWritable,
  checkPortAvailable,
  checkTcpConnection,
  checkHttpReachable
}
