'use strict'

const fs = require('fs')
const path = require('path')

const LEVEL_PRIORITY = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 }

let state = null

function todayStr () {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getDailyLogPath (logDir) {
  return path.join(logDir, `queue-manager-${todayStr()}.log`)
}

function cleanOldLogs (logDir, maxFiles) {
  let files
  try {
    files = fs.readdirSync(logDir)
      .filter(f => /^queue-manager-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
  } catch { return }
  while (files.length > maxFiles) {
    const old = files.shift()
    try { fs.unlinkSync(path.join(logDir, old)) } catch { /* best effort */ }
  }
}

function rotateIfNeeded () {
  if (state.fileLoggingDisabled) return
  const today = todayStr()
  if (state.currentDate === today && state.currentLogPath) return
  state.currentDate = today
  state.currentLogPath = getDailyLogPath(state.logDir)
  cleanOldLogs(state.logDir, state.maxFiles)
}

function fmt (level, component, msg, data) {
  const ts = new Date().toISOString()
  const compStr = component ? `(${component}) ` : ''
  const dataStr = (data && typeof data === 'object' && Object.keys(data).length)
    ? ' ' + JSON.stringify(data)
    : ''
  return `${ts} [${level.toUpperCase()}] ${compStr}${msg}${dataStr}\n`
}

function emit (level, component, msg, data) {
  if (!state) {
    process.stderr.write(fmt(level, component, msg, data))
    return
  }
  const minLevel = LEVEL_PRIORITY[state.minLevel] || 20
  if ((LEVEL_PRIORITY[level] || 20) < minLevel) return

  const line = fmt(level, component, msg, data)
  process.stdout.write(line)

  if (!state.fileLoggingDisabled) {
    rotateIfNeeded()
    try {
      fs.appendFileSync(state.currentLogPath, line, 'utf8')
    } catch (e) {
      process.stderr.write(`[logger] file write failed at ${state.currentLogPath}: ${e.message} — disabling file logging\n`)
      state.fileLoggingDisabled = true
    }
  }

  if (level === 'critical' && state.platform && typeof state.platform.logSystemEvent === 'function') {
    try { state.platform.logSystemEvent(level, msg) } catch { /* best effort */ }
  }
}

function child (component) {
  return {
    debug: (msg, data) => emit('debug', component, msg, data),
    info: (msg, data) => emit('info', component, msg, data),
    warn: (msg, data) => emit('warn', component, msg, data),
    error: (msg, data) => emit('error', component, msg, data),
    critical: (msg, data) => emit('critical', component, msg, data),
    child: (sub) => child(component ? `${component}:${sub}` : sub)
  }
}

function init (loggingConfig, platform) {
  const cfg = loggingConfig || {}
  const logDir = platform.getLogDir()
  state = {
    minLevel: cfg.level || 'info',
    maxFiles: cfg.max_files || 7,
    maxFileSizeMb: cfg.max_file_size_mb || 50,
    logDir,
    platform,
    currentDate: null,
    currentLogPath: null,
    fileLoggingDisabled: false
  }
  try {
    fs.mkdirSync(logDir, { recursive: true })
  } catch (e) {
    process.stderr.write(`[logger] cannot create log dir ${logDir}: ${e.message} — file logging disabled\n`)
    state.fileLoggingDisabled = true
    return
  }
  rotateIfNeeded()
}

function setLevel (level) {
  if (state && LEVEL_PRIORITY[level]) state.minLevel = level
}

function close () {
  state = null
}

const root = child(null)
root.init = init
root.setLevel = setLevel
root.close = close
root.child = child

module.exports = root
