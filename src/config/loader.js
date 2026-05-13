'use strict'

const fs = require('fs')
const path = require('path')
const { validate, applyDefaults } = require('./schema')

class ConfigLoadError extends Error {
  constructor (errors, file) {
    super(`Config validation failed (${file || '<unknown>'}):\n  - ${errors.join('\n  - ')}`)
    this.name = 'ConfigLoadError'
    this.errors = errors
    this.file = file
  }
}

function resolveConfigPath () {
  if (process.env.QM_CONFIG_FILE) return process.env.QM_CONFIG_FILE

  const local = path.join(process.cwd(), 'config', 'config.json')
  if (fs.existsSync(local)) return local

  try {
    const platform = require('../platform')
    return path.join(platform.getConfigDir(), 'config.json')
  } catch {
    return local
  }
}

function loadConfig (filePath) {
  const file = filePath || resolveConfigPath()

  if (!fs.existsSync(file)) {
    throw new ConfigLoadError([`file not found: ${file}`], file)
  }

  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new ConfigLoadError([`cannot read file: ${e.message}`], file)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigLoadError([`invalid JSON: ${e.message}`], file)
  }

  const errors = validate(parsed)
  if (errors.length) throw new ConfigLoadError(errors, file)

  const merged = applyDefaults(parsed)
  Object.defineProperty(merged, '__file', { value: file, enumerable: false })
  return merged
}

module.exports = { loadConfig, resolveConfigPath, ConfigLoadError }
