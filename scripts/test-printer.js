'use strict'

/**
 * scripts/test-printer.js
 *
 * Sends a small ESC/POS test page directly to the configured printer
 * (network.printer_new_ip:network.printer_port) to verify network
 * connectivity. Independent of Test Mode — this exercises the printer,
 * not the agent.
 */

const net = require('net')
const path = require('path')

const repoSrc = path.join(__dirname, '..', 'src')
const { loadConfig } = require(path.join(repoSrc, 'config', 'loader'))

let config
try {
  config = loadConfig()
} catch (e) {
  process.stderr.write(`Config error: ${e.message}\n`)
  process.exit(1)
}

const host = config.network.printer_new_ip
const port = config.network.printer_port

const ESC = 0x1B
const GS = 0x1D
const LF = 0x0A

const header = Buffer.from([ESC, 0x40])                // ESC @ — initialize
const cut    = Buffer.from([GS, 0x56, 0x00])           // GS V 0 — full cut
const sep    = Buffer.from(`==============================\n`, 'utf8')
const text   = Buffer.from(
  `\n` +
  `   Queue Manager — Printer Test\n` +
  `   ${new Date().toISOString()}\n` +
  `   target: ${host}:${port}\n\n` +
  `   If you can read this line,\n` +
  `   the printer is reachable.\n\n`,
  'utf8'
)
const tail   = Buffer.from([LF, LF, LF, LF])

const payload = Buffer.concat([header, sep, text, sep, tail, cut])

process.stdout.write(`Sending ${payload.length} bytes to ${host}:${port} ...\n`)

const sock = net.createConnection({ host, port, family: 4 })
const startedAt = Date.now()
let connected = false

sock.setTimeout(5000)

sock.once('connect', () => {
  connected = true
  process.stdout.write(`Connected (${Date.now() - startedAt}ms). Writing payload ...\n`)
  sock.write(payload, (err) => {
    if (err) {
      process.stderr.write(`Write failed: ${err.message}\n`)
      sock.destroy()
      process.exit(1)
    }
    process.stdout.write('Payload sent. Closing connection.\n')
    sock.end()
  })
})

sock.once('timeout', () => {
  process.stderr.write(`Timeout: ${connected ? 'no response after data sent' : 'connect timed out'} (${host}:${port})\n`)
  sock.destroy()
  process.exit(1)
})

sock.once('error', (err) => {
  process.stderr.write(`Connection error: ${err.message} (${host}:${port})\n`)
  process.exit(1)
})

sock.once('close', () => {
  if (connected) {
    process.stdout.write(`Done in ${Date.now() - startedAt}ms.\n`)
    process.stdout.write('If nothing printed, check the printer is online and accepts ESC/POS over TCP.\n')
    process.exit(0)
  }
})
