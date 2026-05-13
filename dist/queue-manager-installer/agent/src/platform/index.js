'use strict'

let adapter

if (process.platform === 'win32') {
  const WindowsAdapter = require('./windows/adapter')
  adapter = new WindowsAdapter()
} else {
  throw new Error(`Unsupported platform: ${process.platform}. Only win32 is supported in v1.0.`)
}

module.exports = adapter
