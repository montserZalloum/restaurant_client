'use strict'

const path = require('path')
const fsp = require('fs/promises')
const { randomUUID } = require('crypto')

const { loadConfig } = require('./config/loader')
const logger = require('./logging/logger')
const JsonlStore = require('./storage/jsonl-store')
const OrderStore = require('./core/orders/store')
const { STATE_RANKS, STATES, TERMINAL_RANK } = require('./core/orders/states')
const SyncQueue = require('./core/sync/queue')
const SettingsListener = require('./core/sync/settings-listener')
const CloudSyncClient = require('./core/sync/client')
const OrderExtractor = require('./core/extractor')
const PrintInterceptor = require('./core/interceptor')
const { createHttpServer, loadStatic } = require('./server/http-server')
const StaffWebSocketServer = require('./server/ws-server')
const { runHealthChecks, printBanner } = require('./health/checker')

const PKG_VERSION = require('../package.json').version

const COMPACT_INTERVAL_MS = 60 * 60 * 1000

const cleanupTasks = []
let shuttingDown = false

function registerCleanup (fn) { cleanupTasks.push(fn) }

async function shutdown (signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`received ${signal} — graceful shutdown initiated`)

  for (const task of [...cleanupTasks].reverse()) {
    try { await task() } catch (e) {
      logger.error('cleanup task failed', { error: e.message })
    }
  }
  logger.info('Queue Manager توقف')
  logger.close()
  process.exit(code)
}

async function main () {
  const args = process.argv.slice(2)
  const checkMode = args.includes('--check')

  let config
  try {
    config = loadConfig()
  } catch (err) {
    process.stderr.write(`[STARTUP] Config error:\n${err.message}\n`)
    process.exit(1)
  }

  const platform = require('./platform')
  logger.init(config.logging, platform)
  logger.info(`بدء التشغيل — Queue Manager v${PKG_VERSION}`)

  try {
    const health = await runHealthChecks(config, platform)
    for (const w of health.warnings) logger.warn(w)
    for (const e of health.errors) logger.critical(e)

    if (!health.ok) {
      printBanner(config, platform, health)
      logger.critical('Health checks failed — exiting')
      try { platform.logSystemEvent('critical', 'Queue Manager: health checks failed') } catch { /* best effort */ }
      process.exit(1)
    }

    // ──────────────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────────────
    const dataDir = platform.getDataDir()
    const ordersJsonl = new JsonlStore(path.join(dataDir, 'active_orders.jsonl'))
    const syncQueueJsonl = new JsonlStore(path.join(dataDir, 'sync_queue.jsonl'))

    const dumpRawPayloads = !!(config.debug && config.debug.dump_raw_payloads)
    const captureDir = dumpRawPayloads ? path.join(dataDir, 'captures') : null
    if (captureDir) {
      await fsp.mkdir(captureDir, { recursive: true })
      logger.info('debug: raw payload dumping enabled', { dir: captureDir })
    }

    const orderStore = new OrderStore({ store: ordersJsonl, logger: logger.child('orders') })
    await orderStore.load()

    const syncQueue = new SyncQueue({ store: syncQueueJsonl, logger: logger.child('sync-queue') })
    await syncQueue.load()

    printBanner(config, platform, health, { activeCount: orderStore.size() })

    const startedAt = Date.now()

    // ──────────────────────────────────────────────────────────
    // OrderExtractor
    // ──────────────────────────────────────────────────────────
    const extractor = new OrderExtractor({
      regex: config.extractor.regex,
      logger: logger.child('extractor')
    })

    // ──────────────────────────────────────────────────────────
    // Local HTTP + WebSocket server (PRD #8 §4.1, §4.2)
    // ──────────────────────────────────────────────────────────
    const staticCache = loadStatic()
    let settingsRef = null
    let currentStaffPin = config.staff_pin
    const getCurrentConfig = () => (settingsRef ? settingsRef.getConfig() : config)
    const getStaffPin = () => currentStaffPin
    const getEnv = () => {
      const cfg = getCurrentConfig()
      const cloudWsRoot = cfg.cloud && cfg.cloud.ws_url
      return {
        mode: 'local',
        cloud_ws: cloudWsRoot ? `${cloudWsRoot.replace(/\/$/, '')}/staff` : null,
        cloud_base: (cfg.cloud && cfg.cloud.base_url) || null,
        restaurant_id: (cfg.restaurant && cfg.restaurant.id) || '',
        restaurant_name: (cfg.restaurant && cfg.restaurant.name) || ''
      }
    }
    const getActiveOrders = () => orderStore.getActiveOrders().map(o => ({
      order_id: o.order_id,
      order_number: o.order_number,
      status: o.status,
      status_rank: o.status_rank,
      extracted: o.extracted,
      at: o.at,
      since: o.at
    }))
    const httpServer = createHttpServer({
      logger: logger.child('http'),
      staticCache,
      startedAt,
      getActiveCount: () => orderStore.size(),
      getPrinterStatus: () => interceptor && interceptor.getPrinterStatus(),
      getEnv,
      getStaffPin,
      getActiveOrders
    })
    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(e)
      httpServer.once('error', onErr)
      httpServer.listen(config.local_server.http_port, config.local_server.bind_address, () => {
        httpServer.removeListener('error', onErr)
        const a = httpServer.address()
        logger.info(`local HTTP+WS server listening on ${a.address}:${a.port}`)
        resolve()
      })
    })

    const staffServer = new StaffWebSocketServer({
      httpServer,
      staffPin: config.staff_pin,
      logger: logger.child('staff-ws')
    })

    // ──────────────────────────────────────────────────────────
    // IP alias self-heal (PRD #7 §5.7)
    // ──────────────────────────────────────────────────────────
    try {
      const aliasResult = platform.ensureIpAliasPersistent(
        config.network.printer_old_ip,
        config.network.interface_name
      )
      if (aliasResult && aliasResult.configured && aliasResult.alreadyPresent === false) {
        logger.info('IP alias re-added at startup', aliasResult)
      } else if (aliasResult && !aliasResult.configured) {
        logger.warn('IP alias not configured — install.bat may not have run, or netsh failed', aliasResult)
      }
    } catch (e) {
      logger.warn('ensureIpAliasPersistent threw', { err: e.message })
    }

    // ──────────────────────────────────────────────────────────
    // Print Interceptor (PRD #2 §3)
    // ──────────────────────────────────────────────────────────
    const interceptBinding = await platform.setupPrintInterception(config)
    const interceptor = new PrintInterceptor({
      bindAddress: interceptBinding.bindAddress,
      bindPort: interceptBinding.bindPort,
      cashierIp: config.network.cashier_ip,
      targetHost: config.network.printer_new_ip,
      targetPort: config.network.printer_port,
      logger: logger.child('interceptor')
    })
    await interceptor.start()

    // ──────────────────────────────────────────────────────────
    // Cloud sync client (PRD #2 §7, PRD #8 §4.4)
    // ──────────────────────────────────────────────────────────
    const cloudClient = new CloudSyncClient({
      config,
      logger: logger.child('cloud'),
      syncQueue,
      pkgVersion: PKG_VERSION,
      getStatusSnapshot: () => ({
        lan_ips: platform.getLocalIpAddresses(),
        local_ws_port: config.local_server.websocket_port,
        local_http_port: config.local_server.http_port,
        active_orders_count: orderStore.size(),
        sync_queue_size: syncQueue.size(),
        printer_status: interceptor.getPrinterStatus().status,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000)
      })
    })

    // ──────────────────────────────────────────────────────────
    // Settings listener wiring (hot reloads)
    // ──────────────────────────────────────────────────────────
    const settings = new SettingsListener({
      initialConfig: config,
      configFilePath: config.__file,
      logger: logger.child('settings'),
      hooks: {
        onLogLevelChange: (level) => logger.setLevel(level),
        onStaffPinChange: (newPin /*, oldPin */) => {
          currentStaffPin = newPin
          staffServer.setStaffPin(newPin)
        },
        onExtractorChange: (newExtractor) => {
          try { extractor.setRegex(newExtractor.regex) } catch (e) {
            logger.error('extractor reload failed', { err: e.message })
          }
        },
        onRestartRequired: (restartKeys) => {
          try { platform.logSystemEvent('warning',
            `Queue Manager: restart required for: ${restartKeys.join(', ')}`)
          } catch { /* best effort */ }
        }
      }
    })
    settingsRef = settings

    cloudClient.on('settings_updated', async () => {
      logger.info('cloud signaled settings_updated — reloading')
      try {
        await settings.fetchAndApply(async () => {
          const url = `${config.cloud.base_url}/api/restaurants/${encodeURIComponent(config.restaurant.id)}/config`
          const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${config.restaurant.api_key}` }
          })
          if (!res.ok) throw new Error(`config fetch HTTP ${res.status}`)
          return await res.json()
        })
      } catch (e) {
        logger.error('settings reload failed', { err: e.message })
      }
    })

    // ──────────────────────────────────────────────────────────
    // Event flow: interceptor → orderStore → staff + sync queue
    // ──────────────────────────────────────────────────────────
    async function applyAndFanOut (event) {
      const applied = await orderStore.applyEvent(event)
      if (!applied) return false
      staffServer.broadcast({ type: 'order_event', event_id: event.event_id, data: event })
      if (event.source !== 'cloud') {
        try { await syncQueue.enqueue(event) } catch (e) {
          logger.error('enqueue for cloud sync failed', { err: e.message })
        }
      }
      return true
    }

    interceptor.on('order', async ({ rawData, receivedAt }) => {
      try {
        const extraction = extractor.extract(rawData)
        const event = {
          event_id: randomUUID(),
          order_id: randomUUID(),
          order_number: extraction.order_number,
          extracted: extraction.extracted,
          status: STATES.PREPARING,
          status_rank: STATE_RANKS[STATES.PREPARING],
          at: receivedAt,
          source: 'local'
        }
        logger.info(`new order #${event.order_number} (${extraction.extracted ? 'extracted' : 'fallback'})`,
          { encoding: extraction.encoding, bytes: rawData.length })

        if (captureDir) {
          const ts = new Date(receivedAt).toISOString().replace(/[:.]/g, '-')
          const tag = extraction.extracted ? `n${extraction.order_number}` : `fallback-${extraction.order_number}`
          const filename = `${ts}--${tag}.bin`
          fsp.writeFile(path.join(captureDir, filename), rawData).catch((e) => {
            logger.warn('payload dump write failed', { err: e.message, filename })
          })
        }

        await applyAndFanOut(event)
      } catch (e) {
        logger.error('order intake failed', { err: e.message, stack: e.stack })
      }
    })

    interceptor.on('printer_status', (status) => {
      const message = { type: 'printer_status', data: status }
      staffServer.broadcast(message)
      cloudClient.sendMessage(message)
    })

    // ──────────────────────────────────────────────────────────
    // Staff WS: handle inbound commands
    // ──────────────────────────────────────────────────────────
    staffServer.on('staff_connected', ({ ws }) => {
      try {
        ws.send(JSON.stringify({
          type: 'active_orders',
          data: {
            orders: orderStore.getActiveOrders().map(o => ({
              order_id: o.order_id,
              order_number: o.order_number,
              status: o.status,
              status_rank: o.status_rank,
              extracted: o.extracted,
              at: o.at
            }))
          }
        }))
        ws.send(JSON.stringify({ type: 'printer_status', data: interceptor.getPrinterStatus() }))
      } catch (e) {
        logger.warn('initial state send to staff failed', { err: e.message })
      }
    })

    staffServer.on('order_command', async ({ ws, data }) => {
      if (!data || typeof data.order_id !== 'string' || typeof data.status !== 'string') {
        try { ws.send(JSON.stringify({ type: 'error', error: 'invalid_command' })) } catch { /* */ }
        return
      }
      if (!STATE_RANKS[data.status]) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'invalid_status' })) } catch { /* */ }
        return
      }
      const existing = orderStore.getOrder(data.order_id)
      if (!existing) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'order_not_found' })) } catch { /* */ }
        return
      }
      const event = {
        event_id: randomUUID(),
        order_id: data.order_id,
        order_number: existing.order_number,
        extracted: existing.extracted,
        status: data.status,
        status_rank: STATE_RANKS[data.status],
        at: data.at || Date.now(),
        source: 'staff'
      }
      try { await applyAndFanOut(event) } catch (e) {
        logger.error('staff order_command apply failed', { err: e.message })
      }
    })

    async function clearAllOrders (at, source) {
      const targets = orderStore.getActiveOrders()
      const ts = at || Date.now()
      for (const order of targets) {
        if (order.status_rank >= TERMINAL_RANK) continue
        const event = {
          event_id: randomUUID(),
          order_id: order.order_id,
          order_number: order.order_number,
          extracted: order.extracted,
          status: STATES.CLEARED,
          status_rank: STATE_RANKS[STATES.CLEARED],
          at: ts,
          source
        }
        await applyAndFanOut(event)
      }
      staffServer.broadcast({ type: 'clear_screen', at: ts })
    }

    staffServer.on('clear_screen', async ({ data }) => {
      try { await clearAllOrders(data.at, 'staff') } catch (e) {
        logger.error('staff clear_screen failed', { err: e.message })
      }
    })

    // ──────────────────────────────────────────────────────────
    // Cloud → local: order_event / clear_screen
    // ──────────────────────────────────────────────────────────
    cloudClient.on('order_event', async (msg) => {
      const ev = msg && msg.data
      if (!ev || !ev.order_id || !ev.status) return
      const event = {
        event_id: msg.event_id || ev.event_id || randomUUID(),
        order_id: ev.order_id,
        order_number: ev.order_number,
        extracted: ev.extracted !== false,
        status: ev.status,
        status_rank: ev.status_rank != null ? ev.status_rank : STATE_RANKS[ev.status],
        at: ev.at || Date.now(),
        source: ev.source || 'cloud'
      }
      try {
        const applied = await orderStore.applyEvent(event)
        if (applied) {
          staffServer.broadcast({ type: 'order_event', event_id: event.event_id, data: event })
        }
      } catch (e) {
        logger.error('cloud order_event apply failed', { err: e.message })
      }
    })

    cloudClient.on('clear_screen', async (msg) => {
      const at = (msg && msg.data && msg.data.at) || Date.now()
      try { await clearAllOrders(at, 'cloud') } catch (e) {
        logger.error('cloud clear_screen failed', { err: e.message })
      }
    })

    cloudClient.start()

    // Periodic compaction of active_orders.jsonl
    const compactTimer = setInterval(async () => {
      try {
        const r = await orderStore.compact()
        logger.debug('orders compacted', r)
      } catch (e) {
        logger.error('compact failed', { err: e.message })
      }
    }, COMPACT_INTERVAL_MS)
    compactTimer.unref?.()

    // ──────────────────────────────────────────────────────────
    // Cleanup
    // ──────────────────────────────────────────────────────────
    registerCleanup(async () => { clearInterval(compactTimer) })
    registerCleanup(async () => { await cloudClient.stop() })
    registerCleanup(async () => { staffServer.close() })
    registerCleanup(async () => {
      await new Promise((resolve) => httpServer.close(() => resolve()))
    })
    registerCleanup(async () => { await interceptor.stop() })
    registerCleanup(async () => {
      try { await platform.teardownPrintInterception() } catch { /* best effort */ }
    })
    registerCleanup(async () => {
      logger.info(`order store size at shutdown: ${orderStore.size()}, sync queue: ${syncQueue.size()}`)
    })

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('uncaughtException', (err) => {
      logger.critical('uncaught exception', { error: err.message, stack: err.stack })
      try { platform.logSystemEvent('critical', `uncaught: ${err.message}`) } catch { /* best effort */ }
      shutdown('uncaughtException', 1)
    })
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandled promise rejection', { reason: String(reason) })
    })

    logger.info('Queue Manager جاهز')

    if (checkMode) {
      logger.info('--check mode: exiting after successful startup')
      await shutdown('--check', 0)
      return
    }

    return { config, platform, orderStore, syncQueue, settings, interceptor, cloudClient, staffServer, httpServer, logger }
  } catch (err) {
    logger.critical('فشل بدء التشغيل', { error: err.message, stack: err.stack })
    try { platform.logSystemEvent('critical', err.message) } catch { /* best effort */ }
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[STARTUP] unhandled: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}

module.exports = { main, shutdown, registerCleanup }
