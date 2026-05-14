'use strict'

/**
 * scripts/setup-helper.js
 *
 * Bridge between install.bat / uninstall.bat / test-mode.bat and the JS
 * platform modules. Each subcommand exits with code 0 on success, non-zero
 * on failure, and prints structured KEY=VALUE lines (or human messages)
 * to stdout for batch to consume via `for /f`.
 *
 * Usage:
 *   node setup-helper.js check-node
 *   node setup-helper.js verify-config <config>
 *   node setup-helper.js verify-cloud <config>
 *   node setup-helper.js extract-vars <config>
 *   node setup-helper.js print-summary <config>
 *   node setup-helper.js firewall-add <config>
 *   node setup-helper.js firewall-remove
 *   node setup-helper.js firewall-test-mode-add
 *   node setup-helper.js firewall-test-mode-remove
 *   node setup-helper.js alias-add <config>
 *   node setup-helper.js alias-remove <config>
 *   node setup-helper.js service-install <config> --nssm=PATH --node=PATH --script=PATH --app-dir=PATH --config-file=PATH [--stdout=PATH] [--stderr=PATH] [--data-dir=PATH] [--log-dir=PATH]
 *   node setup-helper.js service-stop [--service-name=NAME] [--timeout=MS]
 *   node setup-helper.js service-uninstall --nssm=PATH [--service-name=NAME] [--timeout=MS]
 *   node setup-helper.js service-status [--service-name=NAME]
 *   node setup-helper.js debug-capture-enable <config>
 *   node setup-helper.js debug-capture-disable <config>
 *   node setup-helper.js debug-capture-status <config>
 */

const REQUIRED_NODE_MAJOR = 20

const path = require('path')
const fs = require('fs')

function findSrcRoot () {
  const candidates = [
    path.join(__dirname, 'agent', 'src'),       // packaged: this script at pkg root, src under agent/
    path.join(__dirname, '..', 'src')           // repo: this script at scripts/, src one up
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'platform', 'index.js'))) return c
  }
  fail(`cannot locate src/ — tried:\n  - ${candidates.join('\n  - ')}`)
}

function fail (msg, code = 1) {
  process.stderr.write(`[setup-helper] ${msg}\n`)
  process.exit(code)
}

function parseFlags (args) {
  const flags = {}
  const positional = []
  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else flags[a.slice(2)] = true
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

const SRC = findSrcRoot()
const AGENT_ROOT = path.dirname(SRC)
const firewall = require(path.join(SRC, 'platform', 'windows', 'firewall'))
const network = require(path.join(SRC, 'platform', 'windows', 'network'))
const service = require(path.join(SRC, 'platform', 'windows', 'service'))
const { loadConfig } = require(path.join(SRC, 'config', 'loader'))
const { checkHttpReachable } = require(path.join(SRC, 'health', 'checker'))

function loadOrFail (configPath) {
  if (!configPath) fail('config path required')
  process.env.QM_CONFIG_FILE = configPath
  try { return loadConfig(configPath) } catch (e) {
    fail(`config load/validate failed: ${e.message}`)
  }
}

// ── Subcommands ─────────────────────────────────────────

function cmdCheckNode () {
  const v = process.versions.node
  const major = parseInt(v.split('.')[0], 10)
  if (!Number.isFinite(major) || major < REQUIRED_NODE_MAJOR) {
    process.stderr.write(`Node ${v} is too old. Need Node ${REQUIRED_NODE_MAJOR} or newer.\n`)
    return 1
  }
  process.stdout.write(`OK ${v}\n`)
  return 0
}

function cmdVerifyConfig (args) {
  const cfg = loadOrFail(args[0])
  process.stdout.write('OK\n')
  return 0
}

function checkWsHandshake (wsBaseUrl, restaurantId, apiKey, timeoutMs) {
  const WebSocket = require(path.join(AGENT_ROOT, 'node_modules', 'ws'))
  const url = `${wsBaseUrl.replace(/\/$/, '')}/local-agent` +
    `?restaurant_id=${encodeURIComponent(restaurantId)}` +
    `&api_key=${encodeURIComponent(apiKey)}`
  return new Promise((resolve) => {
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
      return resolve({ ok: false, reason: e.message })
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'TIMEOUT' }), timeoutMs + 200)
    timer.unref?.()
    ws.once('open', () => finish({ ok: true }))
    ws.once('unexpected-response', (_req, res) => {
      finish({ ok: false, reason: `HTTP ${res.statusCode}` })
    })
    ws.once('error', (e) => finish({ ok: false, reason: e.code || e.message }))
  })
}

async function cmdVerifyCloud (args) {
  const cfg = loadOrFail(args[0])
  const baseUrl = cfg.cloud && cfg.cloud.base_url
  const wsUrl = cfg.cloud && cfg.cloud.ws_url
  const restaurantId = cfg.restaurant && cfg.restaurant.id
  const apiKey = cfg.restaurant && cfg.restaurant.api_key

  if (!baseUrl || !wsUrl || !restaurantId || !apiKey) {
    fail('verify-cloud: missing cloud.base_url, cloud.ws_url, restaurant.id, or restaurant.api_key')
  }

  const w = (s) => process.stdout.write(s + '\n')
  w(`cloud HTTP : ${baseUrl}`)
  w(`cloud WS   : ${wsUrl}`)
  w(`restaurant : ${restaurantId}`)
  w('---------------------------------')

  const httpHealth = await checkHttpReachable(`${baseUrl.replace(/\/$/, '')}/health`, 3000)
  if (httpHealth.ok) w(`OK_HTTP /health (status ${httpHealth.status})`)
  else w(`FAIL_HTTP ${httpHealth.reason}`)

  const wsResult = await checkWsHandshake(wsUrl, restaurantId, apiKey, 4000)
  if (wsResult.ok) w(`OK_WS /local-agent`)
  else w(`FAIL_WS ${wsResult.reason}`)

  return (httpHealth.ok && wsResult.ok) ? 0 : 1
}

function cmdExtractVars (args) {
  const cfg = loadOrFail(args[0])
  const lines = [
    `RESTAURANT_ID=${cfg.restaurant.id}`,
    `PRINTER_OLD_IP=${cfg.network.printer_old_ip || ''}`,
    `PRINTER_NEW_IP=${cfg.network.printer_new_ip}`,
    `PRINTER_PORT=${cfg.network.printer_port}`,
    `INTERFACE_NAME=${cfg.network.interface_name || 'auto'}`,
    `LOCAL_HTTP_PORT=${cfg.local_server.http_port}`,
    `LOCAL_WS_PORT=${cfg.local_server.websocket_port}`,
    `SERVICE_NAME=${cfg.service.name}`,
    `SERVICE_DISPLAY_NAME=${cfg.service.display_name}`
  ]
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

function cmdPrintSummary (args) {
  const cfg = loadOrFail(args[0])
  const w = (s) => process.stdout.write(s + '\n')
  w('==========================================')
  w('  Queue Manager - About to install')
  w('==========================================')
  w(`Restaurant      : ${cfg.restaurant.name || '(unnamed)'}`)
  w(`Restaurant ID   : ${cfg.restaurant.id}`)
  w(`Original printer: ${cfg.network.printer_old_ip || '(not set — alias step skipped)'}`)
  w(`Forwarded to    : ${cfg.network.printer_new_ip}:${cfg.network.printer_port}`)
  w(`Cashier IP      : ${cfg.network.cashier_ip}`)
  w(`Interface       : ${cfg.network.interface_name || 'auto'}`)
  w(`Local server    : :${cfg.local_server.http_port} (HTTP+WS)`)
  w(`Service         : ${cfg.service.name} (${cfg.service.display_name})`)
  w(`Cloud           : ${cfg.cloud.base_url}`)
  w('==========================================')
  return 0
}

function cmdFirewallAdd (args) {
  const cfg = loadOrFail(args[0])
  const rules = firewall.buildDefaultRules({
    printPort: cfg.network.printer_port,
    localPort: cfg.local_server.http_port
  })
  const out = firewall.configureFirewall({ add: rules })
  if (out.errors.length) {
    process.stderr.write(`firewall-add encountered ${out.errors.length} error(s):\n`)
    for (const e of out.errors) process.stderr.write(`  - ${e.rule}: ${e.error}\n`)
    return 1
  }
  for (const r of out.added) {
    process.stdout.write(`ADDED  ${r.name}${r.alreadyExisted ? ' (already existed)' : ''}\n`)
  }
  return 0
}

function cmdFirewallRemove () {
  const names = [
    firewall.RULE_PRINT_RECEIVER,
    firewall.RULE_LOCAL_SERVER,
    firewall.RULE_CLOUD_CONNECTION,
    firewall.RULE_TEST_MODE
  ]
  const out = firewall.configureFirewall({ remove: names })
  for (const r of out.removed) {
    process.stdout.write(`REMOVED ${r.name}${r.deleted ? '' : ' (was not present)'}\n`)
  }
  for (const e of out.errors) {
    process.stderr.write(`firewall-remove error: ${e.rule}: ${e.error}\n`)
  }
  return out.errors.length ? 1 : 0
}

function cmdFirewallTestModeAdd () {
  try { firewall.ensureRule(firewall.DEFAULT_RULES.test_mode) } catch (e) {
    fail(`failed to add test-mode firewall rule: ${e.message}`)
  }
  process.stdout.write('ADDED ' + firewall.RULE_TEST_MODE + '\n')
  return 0
}

function cmdFirewallTestModeRemove () {
  const r = firewall.deleteRule(firewall.RULE_TEST_MODE)
  process.stdout.write('REMOVED ' + r.name + (r.deleted ? '' : ' (was not present)') + '\n')
  return 0
}

function cmdAliasAdd (args) {
  const cfg = loadOrFail(args[0])
  const ip = cfg.network.printer_old_ip
  if (!ip) {
    process.stdout.write('SKIPPED no printer_old_ip configured\n')
    return 0
  }
  const ifname = cfg.network.interface_name || 'auto'
  try {
    if (network.hasIpAlias(ip)) {
      process.stdout.write(`ALREADY_PRESENT ${ip}\n`)
      return 0
    }
    const r = network.addIpAlias(ip, undefined, ifname)
    process.stdout.write(`ADDED ${r.ip} on ${r.interface} (${r.mask})\n`)
  } catch (e) {
    fail(`alias-add failed: ${e.message}`)
  }
  return 0
}

function cmdAliasRemove (args) {
  const cfg = loadOrFail(args[0])
  const ip = cfg.network.printer_old_ip
  if (!ip) {
    process.stdout.write('SKIPPED no printer_old_ip configured\n')
    return 0
  }
  const ifname = cfg.network.interface_name || 'auto'
  try {
    const r = network.deleteIpAlias(ip, ifname)
    process.stdout.write(`REMOVED ${r.ip} on ${r.interface}${r.deleted ? '' : ' (was not present)'}\n`)
  } catch (e) {
    fail(`alias-remove failed: ${e.message}`)
  }
  return 0
}

function cmdServiceInstall (args) {
  const { flags, positional } = parseFlags(args)
  const cfg = loadOrFail(positional[0])

  const required = ['nssm', 'node', 'script', 'app-dir', 'config-file']
  for (const k of required) {
    if (!flags[k]) fail(`service-install: --${k}=PATH required`)
  }

  const env = {
    QM_CONFIG_FILE: flags['config-file']
  }
  if (flags['data-dir']) env.QM_DATA_ROOT = path.dirname(flags['data-dir'])
  if (flags['log-dir']) env.QM_LOG_DIR = flags['log-dir']

  try {
    const r = service.installAsService({
      nssmPath: flags.nssm,
      nodePath: flags.node,
      scriptPath: flags.script,
      appDirectory: flags['app-dir'],
      serviceName: cfg.service.name,
      displayName: cfg.service.display_name,
      description: 'Queue Manager Local Agent — intercepts print jobs and forwards them',
      env,
      stdoutLog: flags.stdout || null,
      stderrLog: flags.stderr || null,
      restartDelayMs: (cfg.service.recovery.first_failure_delay_sec || 5) * 1000,
      recovery: cfg.service.recovery
    })
    process.stdout.write(`INSTALLED ${r.serviceName}\n`)
    if (r.recovery && r.recovery.applied) {
      process.stdout.write(
        `RECOVERY  reset_period=${r.recovery.periodSeconds}s delays_ms=${r.recovery.delaysMs.join(',')}\n`
      )
    } else if (r.recovery && r.recovery.error) {
      process.stdout.write(`RECOVERY  WARN: ${r.recovery.error}\n`)
    }
  } catch (e) {
    fail(`service-install failed: ${e.message}`)
  }
  return 0
}

function cmdServiceStop (args) {
  const { flags } = parseFlags(args)
  const serviceName = flags['service-name'] || service.DEFAULT_SERVICE_NAME
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 30000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail('service-stop: --timeout must be a positive number of milliseconds')
  }
  try {
    const r = service.stopServiceWithTimeout(serviceName, timeoutMs)
    if (r.stopped) {
      if (r.alreadyStopped) process.stdout.write(`ALREADY_STOPPED ${serviceName}\n`)
      else if (r.forced) process.stdout.write(`STOPPED ${serviceName} (forced kill of PID ${r.pid})\n`)
      else process.stdout.write(`STOPPED ${serviceName}\n`)
      return 0
    }
    if (r.reason === 'not_installed') {
      process.stdout.write(`NOT_INSTALLED ${serviceName}\n`)
      return 0
    }
    process.stderr.write(`STOP_FAILED ${serviceName}: ${r.reason || 'unknown'} (state=${r.state || '?'}, pid=${r.pid || '?'})\n`)
    return 1
  } catch (e) {
    fail(`service-stop failed: ${e.message}`)
  }
}

function cmdServiceUninstall (args) {
  const { flags } = parseFlags(args)
  if (!flags.nssm) fail('service-uninstall: --nssm=PATH required')
  const serviceName = flags['service-name'] || service.DEFAULT_SERVICE_NAME
  const stopTimeoutMs = flags.timeout ? Number(flags.timeout) : 30000
  try {
    const r = service.uninstallService({ nssmPath: flags.nssm, serviceName, stopTimeoutMs })
    if (r.uninstalled) process.stdout.write(`UNINSTALLED ${r.serviceName}\n`)
    else process.stdout.write(`NOT_PRESENT ${serviceName}\n`)
  } catch (e) {
    fail(`service-uninstall failed: ${e.message}`)
  }
  return 0
}

function cmdServiceStatus (args) {
  const { flags } = parseFlags(args)
  const serviceName = flags['service-name'] || service.DEFAULT_SERVICE_NAME
  const installed = service.isServiceInstalled(serviceName)
  process.stdout.write(`INSTALLED=${installed ? '1' : '0'}\n`)
  return 0
}

function readRawConfig (configPath) {
  if (!configPath) fail('config path required')
  let raw
  try { raw = fs.readFileSync(configPath, 'utf8') } catch (e) {
    fail(`cannot read ${configPath}: ${e.message}`)
  }
  let cfg
  try { cfg = JSON.parse(raw) } catch (e) {
    fail(`invalid JSON in ${configPath}: ${e.message}`)
  }
  return cfg
}

function setDumpFlag (configPath, value) {
  const cfg = readRawConfig(configPath)
  if (!cfg.debug || typeof cfg.debug !== 'object') cfg.debug = {}
  const oldValue = !!cfg.debug.dump_raw_payloads
  cfg.debug.dump_raw_payloads = value

  if (oldValue === value) {
    process.stdout.write(`UNCHANGED dump_raw_payloads=${value}\n`)
    return 0
  }

  const { validate } = require(path.join(SRC, 'config', 'schema'))
  const errs = validate(cfg)
  if (errs.length) fail(`config validation failed after edit: ${errs.join(', ')}`)

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
  process.stdout.write(`UPDATED dump_raw_payloads=${value}\n`)
  process.stdout.write(`NOTE restart agent for change to take effect\n`)
  return 0
}

function cmdDebugCaptureEnable (args) {
  return setDumpFlag(args[0], true)
}

function cmdDebugCaptureDisable (args) {
  return setDumpFlag(args[0], false)
}

function cmdDebugCaptureStatus (args) {
  const cfg = readRawConfig(args[0])
  const enabled = !!(cfg.debug && cfg.debug.dump_raw_payloads)
  process.stdout.write(`DUMP_RAW_PAYLOADS=${enabled ? '1' : '0'}\n`)
  process.stdout.write(`CONFIG=${args[0]}\n`)
  return 0
}

// ── Dispatch ────────────────────────────────────────────

const subcommand = process.argv[2]
const subargs = process.argv.slice(3)

const COMMANDS = {
  'check-node': cmdCheckNode,
  'verify-config': cmdVerifyConfig,
  'verify-cloud': cmdVerifyCloud,
  'extract-vars': cmdExtractVars,
  'print-summary': cmdPrintSummary,
  'firewall-add': cmdFirewallAdd,
  'firewall-remove': cmdFirewallRemove,
  'firewall-test-mode-add': cmdFirewallTestModeAdd,
  'firewall-test-mode-remove': cmdFirewallTestModeRemove,
  'alias-add': cmdAliasAdd,
  'alias-remove': cmdAliasRemove,
  'service-install': cmdServiceInstall,
  'service-stop': cmdServiceStop,
  'service-uninstall': cmdServiceUninstall,
  'service-status': cmdServiceStatus,
  'debug-capture-enable': cmdDebugCaptureEnable,
  'debug-capture-disable': cmdDebugCaptureDisable,
  'debug-capture-status': cmdDebugCaptureStatus
}

if (!subcommand || !COMMANDS[subcommand]) {
  process.stderr.write(`usage: setup-helper <subcommand> [args]\n`)
  process.stderr.write(`subcommands:\n  ${Object.keys(COMMANDS).join('\n  ')}\n`)
  process.exit(2)
}

Promise.resolve()
  .then(() => COMMANDS[subcommand](subargs))
  .then((code) => process.exit(code | 0))
  .catch((e) => {
    process.stderr.write(`[setup-helper] uncaught: ${e.stack || e.message}\n`)
    process.exit(1)
  })
