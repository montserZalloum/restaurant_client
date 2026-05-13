'use strict'

const { execFile } = require('child_process')

const LEVEL_TO_TYPE = {
  debug: 'INFORMATION',
  info: 'INFORMATION',
  warn: 'WARNING',
  error: 'ERROR',
  critical: 'ERROR'
}

const LEVEL_TO_ID = {
  debug: 100,
  info: 200,
  warn: 300,
  error: 400,
  critical: 500
}

function logSystemEvent (level, message) {
  const type = LEVEL_TO_TYPE[level] || 'INFORMATION'
  const id = LEVEL_TO_ID[level] || 200
  const description = String(message).slice(0, 1024)
  execFile(
    'eventcreate',
    [
      '/SO', 'QueueManager',
      '/T', type,
      '/ID', String(id),
      '/L', 'APPLICATION',
      '/D', description
    ],
    { windowsHide: true },
    () => { /* best-effort; ignore errors (e.g. missing privileges) */ }
  )
}

module.exports = { logSystemEvent }
