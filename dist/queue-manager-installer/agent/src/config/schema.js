'use strict'

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const API_KEY_RE = /^[A-Za-z0-9_-]{16,}$/

function isValidPort (p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535
}

function isValidIp (ip) {
  if (typeof ip !== 'string' || !IPV4_RE.test(ip)) return false
  return ip.split('.').every(o => {
    const n = Number(o)
    return n >= 0 && n <= 255
  })
}

function isValidUrl (s, schemes) {
  if (typeof s !== 'string') return false
  try {
    const u = new URL(s)
    return schemes.includes(u.protocol)
  } catch {
    return false
  }
}

function isValidRegex (s) {
  try { new RegExp(s); return true } catch { return false }
}

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'critical'])

function validate (config) {
  const errors = []
  const err = (p, msg) => errors.push(`${p}: ${msg}`)

  if (typeof config !== 'object' || config === null) {
    return ['config must be an object']
  }

  if (config.version !== 1) err('version', 'expected 1')

  if (!config.restaurant || typeof config.restaurant !== 'object') {
    err('restaurant', 'must be an object')
  } else {
    if (typeof config.restaurant.id !== 'string' || !config.restaurant.id) {
      err('restaurant.id', 'required non-empty string')
    }
    if (typeof config.restaurant.api_key !== 'string' || !config.restaurant.api_key) {
      err('restaurant.api_key', 'required non-empty string')
    } else if (!API_KEY_RE.test(config.restaurant.api_key)) {
      err('restaurant.api_key', 'must match /^[A-Za-z0-9_-]{16,}$/ (URL-safe, ≥16 chars)')
    }
  }

  if (typeof config.staff_pin !== 'string' || !config.staff_pin) {
    err('staff_pin', 'required non-empty string (PRD #8: root-level)')
  } else if (!/^\d{4,8}$/.test(config.staff_pin)) {
    err('staff_pin', 'must be 4-8 digits')
  }

  if (!config.cloud || typeof config.cloud !== 'object') {
    err('cloud', 'must be an object')
  } else {
    if (!isValidUrl(config.cloud.base_url, ['https:', 'http:'])) {
      err('cloud.base_url', 'must be valid http/https URL')
    }
    if (!isValidUrl(config.cloud.ws_url, ['wss:', 'ws:'])) {
      err('cloud.ws_url', 'must be valid ws/wss URL')
    }
  }

  if (!config.network || typeof config.network !== 'object') {
    err('network', 'must be an object')
  } else {
    if (!isValidIp(config.network.cashier_ip)) {
      err('network.cashier_ip', 'must be IPv4')
    }
    if (!isValidIp(config.network.printer_new_ip)) {
      err('network.printer_new_ip', 'must be IPv4')
    }
    if (config.network.printer_old_ip != null && !isValidIp(config.network.printer_old_ip)) {
      err('network.printer_old_ip', 'must be IPv4 if present')
    }
    if (!isValidPort(config.network.printer_port)) {
      err('network.printer_port', 'must be valid port (1-65535)')
    }
  }

  if (!config.extractor || typeof config.extractor !== 'object') {
    err('extractor', 'must be an object')
  } else {
    if (typeof config.extractor.regex !== 'string' || !isValidRegex(config.extractor.regex)) {
      err('extractor.regex', 'must be a valid regex string')
    }
    if (config.extractor.ocr != null) {
      if (typeof config.extractor.ocr !== 'object') {
        err('extractor.ocr', 'must be an object if present')
      } else {
        if (config.extractor.ocr.enabled != null &&
            typeof config.extractor.ocr.enabled !== 'boolean') {
          err('extractor.ocr.enabled', 'must be boolean if present')
        }
        if (config.extractor.ocr.enabled === true) {
          if (typeof config.extractor.ocr.regex !== 'string' ||
              !isValidRegex(config.extractor.ocr.regex)) {
            err('extractor.ocr.regex', 'required valid regex string when ocr.enabled')
          }
        } else if (config.extractor.ocr.regex != null) {
          if (typeof config.extractor.ocr.regex !== 'string' ||
              !isValidRegex(config.extractor.ocr.regex)) {
            err('extractor.ocr.regex', 'must be valid regex string if present')
          }
        }
      }
    }
  }

  if (!config.local_server || typeof config.local_server !== 'object') {
    err('local_server', 'must be an object')
  } else {
    if (!isValidPort(config.local_server.websocket_port)) {
      err('local_server.websocket_port', 'must be valid port (1-65535)')
    }
    if (config.local_server.http_port != null && !isValidPort(config.local_server.http_port)) {
      err('local_server.http_port', 'must be valid port if present')
    }
  }

  if (config.logging && typeof config.logging === 'object') {
    if (config.logging.level && !VALID_LOG_LEVELS.has(config.logging.level)) {
      err('logging.level', `must be one of ${[...VALID_LOG_LEVELS].join(', ')}`)
    }
  }

  if (config.debug != null) {
    if (typeof config.debug !== 'object') {
      err('debug', 'must be an object if present')
    } else if (config.debug.dump_raw_payloads != null &&
               typeof config.debug.dump_raw_payloads !== 'boolean') {
      err('debug.dump_raw_payloads', 'must be boolean if present')
    }
  }

  return errors
}

const DEFAULTS = {
  service: {
    name: 'QueueManager',
    display_name: 'Queue Manager Service',
    recovery: {
      first_failure_delay_sec: 5,
      second_failure_delay_sec: 10,
      third_failure_delay_sec: 20,
      max_failures_in_period: 10,
      failure_period_minutes: 30
    }
  },
  local_server: {
    bind_address: '0.0.0.0'
  },
  logging: {
    level: 'info',
    max_file_size_mb: 50,
    max_files: 7
  }
}

function applyDefaults (config) {
  const out = { ...config }

  out.service = { ...DEFAULTS.service, ...(config.service || {}) }
  out.service.recovery = {
    ...DEFAULTS.service.recovery,
    ...((config.service && config.service.recovery) || {})
  }

  out.local_server = { ...DEFAULTS.local_server, ...(config.local_server || {}) }
  if (out.local_server.http_port == null) {
    out.local_server.http_port = out.local_server.websocket_port
  }

  out.logging = { ...DEFAULTS.logging, ...(config.logging || {}) }

  return out
}

module.exports = { validate, applyDefaults, DEFAULTS, VALID_LOG_LEVELS }
