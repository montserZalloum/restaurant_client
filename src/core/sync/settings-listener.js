'use strict'

const { writeConfig, diffKeys, classifyChanges } = require('../../config/updater')
const { applyDefaults } = require('../../config/schema')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

class SettingsListener {
  constructor ({ initialConfig, configFilePath, logger, hooks } = {}) {
    if (!initialConfig) throw new Error('SettingsListener: initialConfig is required')
    if (!configFilePath) throw new Error('SettingsListener: configFilePath is required')
    this.config = initialConfig
    this.configFilePath = configFilePath
    this.logger = logger || noopLogger
    this.hooks = hooks || {}
  }

  getConfig () {
    return this.config
  }

  async applyNewConfig (newConfig) {
    const merged = applyDefaults(newConfig)
    const changedKeys = diffKeys(this.config, merged)
    if (changedKeys.length === 0) {
      this.logger.info('settings update: no changes')
      return { applied: false, hot: [], restart: [], changedKeys: [] }
    }

    const { hot, restart } = classifyChanges(changedKeys)
    this.logger.info(
      `settings update: ${hot.length} hot-reloadable, ${restart.length} restart-required`,
      { changed: changedKeys }
    )

    writeConfig(this.configFilePath, merged)

    const prev = this.config
    this.config = merged
    Object.defineProperty(this.config, '__file', {
      value: this.configFilePath, enumerable: false, configurable: true
    })

    this._fireHooks(prev, merged, changedKeys, restart)

    return { applied: true, hot, restart, changedKeys }
  }

  _fireHooks (prev, next, changedKeys, restartKeys) {
    const safeCall = (name, fn, ...args) => {
      if (typeof fn !== 'function') return
      try { fn(...args) } catch (e) {
        this.logger.error(`hook ${name} threw`, { error: e.message })
      }
    }

    if (changedKeys.includes('staff_pin')) {
      this.logger.info('staff_pin changed — connected staff will be kicked')
      safeCall('onStaffPinChange', this.hooks.onStaffPinChange, next.staff_pin, prev.staff_pin)
    }

    if (changedKeys.includes('logging.level')) {
      this.logger.info(`logging.level changed: ${prev.logging.level} → ${next.logging.level}`)
      safeCall('onLogLevelChange', this.hooks.onLogLevelChange, next.logging.level)
    }

    if (changedKeys.some(k => k === 'extractor' || k.startsWith('extractor.'))) {
      this.logger.info('extractor config changed — reloading rule')
      safeCall('onExtractorChange', this.hooks.onExtractorChange, next.extractor)
    }

    if (changedKeys.some(k => k.startsWith('service.recovery'))) {
      safeCall('onServiceRecoveryChange', this.hooks.onServiceRecoveryChange, next.service.recovery)
    }

    if (restartKeys.length > 0) {
      this.logger.warn(
        `settings: ${restartKeys.length} field(s) require restart to take effect — ` +
        `new values saved to ${this.configFilePath} but running process continues with previous values`,
        { restart_required: restartKeys }
      )
      safeCall('onRestartRequired', this.hooks.onRestartRequired, restartKeys, next)
    }
  }

  async fetchAndApply (fetchFn) {
    if (typeof fetchFn !== 'function') {
      throw new Error('fetchAndApply requires a fetchFn() => Promise<config>')
    }
    const newConfig = await fetchFn()
    return this.applyNewConfig(newConfig)
  }

  makeMessageHandler (fetchFn) {
    return async (message) => {
      if (!message || message.type !== 'settings_updated') return
      this.logger.info('received settings_updated from cloud — fetching new config')
      try {
        await this.fetchAndApply(fetchFn)
      } catch (e) {
        this.logger.error('failed to apply settings update', { error: e.message })
      }
    }
  }
}

module.exports = SettingsListener
