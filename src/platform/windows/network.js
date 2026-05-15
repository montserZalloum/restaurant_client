'use strict'

const os = require('os')
const { execFileSync } = require('child_process')

const VIRTUAL_NAME_HINTS = [
  'loopback',
  'vethernet',
  'vmware',
  'virtualbox',
  'hyper-v',
  'vpn',
  'docker',
  'wsl',
  'tap',
  'tun'
]

const DEFAULT_SUBNET_MASK = '255.255.255.0'

function isVirtualInterface (name) {
  const lower = name.toLowerCase()
  return VIRTUAL_NAME_HINTS.some(hint => lower.includes(hint))
}

function getLocalIpAddresses () {
  const interfaces = os.networkInterfaces()
  const addresses = []
  for (const [name, ifaceList] of Object.entries(interfaces)) {
    if (!ifaceList || isVirtualInterface(name)) continue
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address)
      }
    }
  }
  return addresses
}

function listIpv4OnInterface (interfaceName) {
  if (!interfaceName) return []
  const interfaces = os.networkInterfaces()
  const list = interfaces[interfaceName]
  if (!list) return []
  return list
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => ({ address: i.address, netmask: i.netmask }))
}

function hasIpAlias (ip, interfaceName) {
  if (!ip) return false
  const interfaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue
    if (interfaceName && name !== interfaceName) continue
    for (const iface of list) {
      if (iface.family === 'IPv4' && iface.address === ip) return true
    }
  }
  return false
}

function runNetsh (args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('netsh', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, stdout: out.toString('utf8') }
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString('utf8')) || ''
    const stdout = (e.stdout && e.stdout.toString('utf8')) || ''
    if (allowFail) return { ok: false, code: e.status, stderr, stdout }
    const detail = stderr || stdout || e.message
    const err = new Error(`netsh failed (${e.status}): ${detail.trim()}`)
    err.code = e.status
    err.stderr = stderr
    err.stdout = stdout
    throw err
  }
}

function detectActiveInterface () {
  const interfaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list || isVirtualInterface(name)) continue
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) return name
    }
  }
  return null
}

function resolveInterfaceName (interfaceName) {
  if (!interfaceName || interfaceName === 'auto') {
    const detected = detectActiveInterface()
    if (!detected) {
      throw new Error('cannot auto-detect active network interface — set network.interface_name explicitly')
    }
    return detected
  }
  return interfaceName
}

function addIpAlias (ip, mask, interfaceName) {
  if (!ip) throw new Error('addIpAlias: ip required')
  const ifname = resolveInterfaceName(interfaceName)
  const subnet = mask || DEFAULT_SUBNET_MASK
  runNetsh(['interface', 'ip', 'add', 'address', ifname, ip, subnet])
  return { added: true, ip, interface: ifname, mask: subnet }
}

function deleteIpAlias (ip, interfaceName) {
  if (!ip) throw new Error('deleteIpAlias: ip required')
  const ifname = resolveInterfaceName(interfaceName)
  const r = runNetsh(
    ['interface', 'ip', 'delete', 'address', ifname, ip],
    { allowFail: true }
  )
  return { deleted: r.ok, ip, interface: ifname }
}

function ensureIpAliasPersistent (originalIp, interfaceName, options = {}) {
  if (!originalIp) {
    return { configured: false, reason: 'no_original_ip' }
  }
  let ifname
  try { ifname = resolveInterfaceName(interfaceName) } catch (e) {
    return { configured: false, reason: e.message }
  }

  if (hasIpAlias(originalIp, ifname)) {
    return { configured: true, alreadyPresent: true, interface: ifname, ip: originalIp }
  }

  const mask = options.mask || DEFAULT_SUBNET_MASK
  try {
    addIpAlias(originalIp, mask, ifname)
    return { configured: true, alreadyPresent: false, interface: ifname, ip: originalIp, mask }
  } catch (e) {
    return { configured: false, reason: e.message, interface: ifname, ip: originalIp }
  }
}

/**
 * Resolve where the print interceptor TCP server should listen.
 * - If printer_old_ip is already a local alias, bind directly to it (the cashier
 *   sends to that address, so binding there isolates traffic).
 * - Otherwise fall back to local_server.bind_address (or 0.0.0.0). The agent
 *   will warn — install.bat is expected to set up the alias.
 */
function setupPrintInterception (config) {
  if (!config || !config.network) {
    throw new Error('setupPrintInterception: config.network required')
  }
  const oldIp = config.network.printer_old_ip
  const port = config.network.printer_port
  const fallbackBind = (config.local_server && config.local_server.bind_address) || '0.0.0.0'
  const localIps = getLocalIpAddresses()
  const aliasReady = !!(oldIp && localIps.includes(oldIp))
  const bindAddress = aliasReady ? oldIp : fallbackBind
  return { bindAddress, bindPort: port, aliasReady }
}

function teardownPrintInterception () {
  return { ok: true }
}

module.exports = {
  getLocalIpAddresses,
  listIpv4OnInterface,
  hasIpAlias,
  isVirtualInterface,
  detectActiveInterface,
  resolveInterfaceName,
  addIpAlias,
  deleteIpAlias,
  ensureIpAliasPersistent,
  setupPrintInterception,
  teardownPrintInterception,
  DEFAULT_SUBNET_MASK
}
