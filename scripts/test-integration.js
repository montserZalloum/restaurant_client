'use strict'

// End-to-end smoke test for PRD #2.
//
// Spawns the local agent against the test config in .runtime/, sends a fake
// Arabic print payload through the TCP interceptor, opens a staff WebSocket
// (with PIN auth), and verifies that:
//
//   1. The order is extracted and broadcast as `order_event`.
//   2. The active_orders snapshot is sent on connect.
//   3. A staff `order_command` flips the state and broadcasts back.
//   4. Staff `clear_screen` clears all active orders.
//   5. Wrong-PIN connections are rejected at the HTTP Upgrade.
//
// Run after `npm install`:
//   node scripts/test-integration.js
//
// Exit code 0 = success, 1 = failure.

const path = require('path')
const net = require('net')
const fs = require('fs')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const ROOT = path.resolve(__dirname, '..')
const RUNTIME = path.join(ROOT, '.runtime')
const CONFIG_FILE = path.join(RUNTIME, 'test-config.json')
const DATA_DIR = path.join(RUNTIME, 'data')

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const PRINT_PORT = config.network.printer_port
const WS_PORT = config.local_server.websocket_port
const STAFF_PIN = config.staff_pin
const CASHIER_IP = '127.0.0.1' // we use the loopback exception

const failures = []
function check (label, ok, detail) {
  if (ok) console.log(`  ✓ ${label}`)
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failures.push(label) }
}

function delay (ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForPort (port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' })
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => { sock.destroy(); resolve(false) })
    })
    if (ok) return
    await delay(150)
  }
  throw new Error(`port ${port} never opened`)
}

function startAgent () {
  fs.writeFileSync(path.join(DATA_DIR, 'active_orders.jsonl'), '', 'utf8')
  fs.writeFileSync(path.join(DATA_DIR, 'sync_queue.jsonl'), '', 'utf8')

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QM_DATA_ROOT: RUNTIME,
      QM_CONFIG_FILE: CONFIG_FILE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  child.stdout.on('data', (b) => { stdout += b.toString('utf8') })
  child.stderr.on('data', (b) => { process.stderr.write('[agent stderr] ' + b.toString('utf8')) })
  child.once('exit', (code) => { if (code !== 0 && code !== null) console.log(`agent exited code=${code}`) })
  return { child, getStdout: () => stdout }
}

async function sendCashierPayload (text) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: PRINT_PORT })
    sock.once('connect', () => {
      sock.write(text, 'utf8')
      sock.end()
    })
    sock.once('close', () => resolve())
    sock.once('error', reject)
  })
}

function openStaffWs (pin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/staff?pin=${encodeURIComponent(pin)}`)
    const queue = []
    let waiters = []
    ws.on('open', () => resolve({
      ws,
      next: (predicate, timeoutMs = 3000) => new Promise((res, rej) => {
        const found = queue.findIndex(predicate)
        if (found >= 0) { const [m] = queue.splice(found, 1); return res(m) }
        const t = setTimeout(() => {
          waiters = waiters.filter(w => w !== entry)
          rej(new Error('timeout waiting for matching message'))
        }, timeoutMs)
        const entry = { predicate, res, rej, t }
        waiters.push(entry)
      }),
      pendingCount: () => queue.length,
      close: () => ws.close()
    }))
    ws.on('error', reject)
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')) } catch { return }
      const i = waiters.findIndex(w => w.predicate(m))
      if (i >= 0) {
        const [w] = waiters.splice(i, 1)
        clearTimeout(w.t)
        w.res(m)
      } else {
        queue.push(m)
      }
    })
    ws.on('close', () => {
      for (const w of waiters) { clearTimeout(w.t); w.rej(new Error('socket closed')) }
      waiters = []
    })
  })
}

async function expectWrongPinRejected () {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/staff?pin=000000`)
    let opened = false
    ws.on('open', () => { opened = true; ws.close() })
    ws.on('error', () => resolve(true))
    ws.on('close', () => resolve(!opened))
    ws.on('unexpected-response', () => resolve(true))
  })
}

async function run () {
  console.log('▶ starting agent')
  const agent = startAgent()
  try {
    await waitForPort(WS_PORT, 10000)
    await waitForPort(PRINT_PORT, 10000)

    console.log('\n▶ test 1: wrong PIN rejected at upgrade')
    check('wrong PIN closed connection', await expectWrongPinRejected())

    console.log('\n▶ test 2: open staff WS with valid PIN')
    const staff = await openStaffWs(STAFF_PIN)

    const initial = await staff.next(m => m.type === 'active_orders').catch(() => null)
    check('received active_orders snapshot', initial && Array.isArray(initial.data.orders))

    console.log('\n▶ test 3: send Arabic print payload through interceptor')
    const arabicReceipt = 'فاتورة\nرقم الطلب: 123\nشاي 5 ر.س\n'
    await sendCashierPayload(arabicReceipt)

    const created = await staff.next(m => m.type === 'order_event' && m.data.status === 'preparing', 3000).catch(() => null)
    check('order_event preparing broadcast', !!created)
    check('order_number extracted from Arabic text', created && created.data.order_number === 123,
      created ? `got order_number=${created.data.order_number}` : 'no event')
    check('extracted flag = true', created && created.data.extracted === true)
    check('source = local', created && created.data.source === 'local')

    const orderId = created && created.data.order_id

    console.log('\n▶ test 4: staff order_command flips status to ready')
    if (orderId) {
      staff.ws.send(JSON.stringify({
        type: 'order_command',
        data: { order_id: orderId, status: 'ready', at: Date.now(), pin: STAFF_PIN }
      }))
      const updated = await staff.next(
        m => m.type === 'order_event' && m.data.order_id === orderId && m.data.status === 'ready',
        3000
      ).catch(() => null)
      check('staff order_command broadcast back', !!updated)
      check('updated source = staff', updated && updated.data.source === 'staff')
    } else {
      check('staff order_command — skipped (no order_id)', false)
    }

    console.log('\n▶ test 5: regex fallback when no Arabic match')
    await sendCashierPayload(Buffer.from([0x1B, 0x40, 0x68, 0x69, 0x0A]))
    const fallback = await staff.next(
      m => m.type === 'order_event' && m.data.status === 'preparing' && m.data.extracted === false,
      3000
    ).catch(() => null)
    check('fallback order broadcast', !!fallback)
    check('fallback flagged extracted=false', fallback && fallback.data.extracted === false)

    console.log('\n▶ test 6: clear_screen clears all active orders')
    staff.ws.send(JSON.stringify({ type: 'clear_screen', data: { at: Date.now() } }))
    const clearMsg = await staff.next(m => m.type === 'clear_screen', 3000).catch(() => null)
    check('clear_screen broadcast received', !!clearMsg)

    await delay(300)

    staff.close()
    await delay(200)

    console.log('\n▶ test 7: sync queue captured local events')
    const syncQueueLines = fs.readFileSync(path.join(DATA_DIR, 'sync_queue.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
    check('sync_queue.jsonl has events', syncQueueLines.length > 0,
      `lines=${syncQueueLines.length}`)

    console.log('\n▶ test 8: shutdown')
    agent.child.kill('SIGTERM')
    const { code, signal } = await new Promise((resolve) => {
      agent.child.once('exit', (c, s) => resolve({ code: c, signal: s }))
    })
    // child_process.kill() on Windows always force-terminates regardless of
    // the signal name (POSIX signals don't exist there) — accept either path.
    const cleanExit = code === 0 || (process.platform === 'win32' && code === null)
    check('agent terminated', cleanExit, `code=${code} signal=${signal}`)
  } finally {
    if (!agent.child.killed) {
      try { agent.child.kill('SIGKILL') } catch { /* */ }
    }
  }

  console.log('\n' + '═'.repeat(60))
  if (failures.length === 0) {
    console.log(`ALL CHECKS PASSED`)
    process.exit(0)
  } else {
    console.log(`FAILURES (${failures.length}):`)
    for (const f of failures) console.log('  -', f)
    process.exit(1)
  }
}

run().catch((e) => {
  console.error('integration test crashed:', e.stack || e.message)
  process.exit(1)
})
