'use strict'

class PlatformAdapter {

  getDataDir () { throw new Error('Not implemented') }
  getConfigDir () { throw new Error('Not implemented') }
  getLogDir () { throw new Error('Not implemented') }

  installAsService (options) { throw new Error('Not implemented') }
  uninstallService (options) { throw new Error('Not implemented') }
  isServiceInstalled (serviceName) { throw new Error('Not implemented') }

  setupPrintInterception (config) { throw new Error('Not implemented') }
  teardownPrintInterception () { throw new Error('Not implemented') }

  configureFirewall (rules) { throw new Error('Not implemented') }

  getLocalIpAddresses () { throw new Error('Not implemented') }

  ensureIpAliasPersistent (originalIp, interfaceName) { throw new Error('Not implemented') }

  logSystemEvent (level, message) { throw new Error('Not implemented') }
}

module.exports = PlatformAdapter
