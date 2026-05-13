'use strict'

/**
 * scripts/check-cloud.js
 *
 * Dev-environment connectivity preflight (PRD #9 §6.5, §7.1, §9.1).
 *
 * Loads the active config (honors QM_CONFIG_FILE) and verifies that
 * the cloud is reachable over both HTTP and WebSocket from this machine.
 * Faster feedback than booting the full agent, and isolates network
 * problems from agent-startup problems.
 *
 *   node scripts/check-cloud.js
 *   QM_CONFIG_FILE=C:\path\to\config.dev.json node scripts/check-cloud.js
 */

const path = require('path')
const WebSocket = require('ws')
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'config', 'loader'))
const { checkHttpReachable } = require(path.join(__dirname, '..', 'src', 'health', 'checker'))

const HTTP_TIMEOUT_MS = 3000
const WS_TIMEOUT_MS = 4000

function checkWsHandshake (wsBaseUrl, restaurantId, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const url = `${wsBaseUrl}/local-agent` +
      `?restaurant_id=${encodeURIComponent(restaurantId)}` +
      `&api_key=${encodeURIComponent(apiKey)}`
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { ws.terminate() } catch { /* ignore */ }
      resolve(result)
    }
    let ws
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs })
    } catch (e) {
      return resolve({ ok: false, reason: e.message, url })
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'TIMEOUT', url }), timeoutMs + 200)
    timer.unref?.()
    ws.once('open', () => finish({ ok: true, url }))
    ws.once('unexpected-response', (_req, res) => {
      finish({ ok: false, reason: `HTTP ${res.statusCode}`, url })
    })
    ws.once('error', (e) => finish({ ok: false, reason: e.code || e.message, url }))
  })
}

async function main () {
  let config
  try {
    config = loadConfig()
  } catch (e) {
    process.stderr.write(`[check-cloud] config error: ${e.message}\n`)
    process.exit(2)
  }

  const baseUrl = config.cloud && config.cloud.base_url
  const wsUrl = config.cloud && config.cloud.ws_url
  const restaurantId = config.restaurant && config.restaurant.id
  const apiKey = config.restaurant && config.restaurant.api_key

  process.stdout.write('=================================\n')
  process.stdout.write('Queue Manager — cloud connectivity\n')
  process.stdout.write('=================================\n')
  process.stdout.write(`config        : ${config.__file}\n`)
  process.stdout.write(`restaurant_id : ${restaurantId}\n`)
  process.stdout.write(`cloud HTTP    : ${baseUrl}\n`)
  process.stdout.write(`cloud WS      : ${wsUrl}\n`)
  process.stdout.write('---------------------------------\n')

  const httpHealth = await checkHttpReachable(`${baseUrl.replace(/\/$/, '')}/health`, HTTP_TIMEOUT_MS)
  if (httpHealth.ok) {
    process.stdout.write(`✓ HTTP /health: OK (status ${httpHealth.status})\n`)
  } else {
    process.stdout.write(`✗ HTTP /health: FAILED (${httpHealth.reason})\n`)
  }

  const wsResult = await checkWsHandshake(wsUrl, restaurantId, apiKey, WS_TIMEOUT_MS)
  if (wsResult.ok) {
    process.stdout.write(`✓ WS  /local-agent: OK\n`)
  } else {
    process.stdout.write(`✗ WS  /local-agent: FAILED (${wsResult.reason})\n`)
  }

  process.stdout.write('---------------------------------\n')

  const allOk = httpHealth.ok && wsResult.ok
  if (allOk) {
    process.stdout.write('All checks passed. Cloud is reachable.\n')
    process.exit(0)
  }

  process.stdout.write('One or more checks failed. Hints:\n')
  process.stdout.write('  - Is the cloud running on the Mac? (npm run dev in cloud/)\n')
  process.stdout.write('  - Is the Mac IP in config still correct? (it changes per network)\n')
  process.stdout.write('  - Are both machines on the same Wi-Fi (no client isolation)?\n')
  process.stdout.write('  - Is the Mac firewall allowing inbound on the cloud port?\n')
  process.exit(1)
}

main().catch((e) => {
  process.stderr.write(`[check-cloud] unhandled: ${e.stack || e.message}\n`)
  process.exit(1)
})
