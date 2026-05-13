'use strict'

const fs = require('fs')
const { validate, applyDefaults } = require('./schema')

const RESTART_REQUIRED_PREFIXES = [
  'network',
  'local_server.websocket_port',
  'local_server.http_port',
  'local_server.bind_address',
  'cloud.base_url',
  'cloud.ws_url',
  'service.name',
  'service.display_name'
]

function flattenKeys (obj, prefix = '', out = []) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    out.push(prefix)
    return out
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenKeys(v, key, out)
    } else {
      out.push(key)
    }
  }
  return out
}

function getPath (obj, key) {
  return key.split('.').reduce(
    (acc, p) => (acc == null ? acc : acc[p]),
    obj
  )
}

function diffKeys (oldCfg, newCfg) {
  const allKeys = new Set([
    ...flattenKeys(oldCfg),
    ...flattenKeys(newCfg)
  ])
  const changed = []
  for (const k of allKeys) {
    if (!k) continue
    const a = getPath(oldCfg, k)
    const b = getPath(newCfg, k)
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k)
  }
  return changed
}

function isRestartRequired (key) {
  return RESTART_REQUIRED_PREFIXES.some(
    prefix => key === prefix || key.startsWith(prefix + '.')
  )
}

function classifyChanges (changedKeys) {
  const hot = []
  const restart = []
  for (const k of changedKeys) {
    if (isRestartRequired(k)) restart.push(k)
    else hot.push(k)
  }
  return { hot, restart }
}

function writeConfig (filePath, newConfig) {
  const errors = validate(newConfig)
  if (errors.length) {
    const e = new Error(`Config write rejected:\n  - ${errors.join('\n  - ')}`)
    e.errors = errors
    throw e
  }
  const merged = applyDefaults(newConfig)
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
  return merged
}

module.exports = {
  writeConfig,
  diffKeys,
  classifyChanges,
  isRestartRequired,
  flattenKeys,
  getPath,
  RESTART_REQUIRED_PREFIXES
}
