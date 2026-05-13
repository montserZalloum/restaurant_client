'use strict'

const PlatformAdapter = require('../interface')

const paths = require('./paths')
const network = require('./network')
const firewall = require('./firewall')
const service = require('./service')
const logging = require('./logging')

class WindowsAdapter extends PlatformAdapter {

  getDataDir () { return paths.getDataDir() }
  getConfigDir () { return paths.getConfigDir() }
  getLogDir () { return paths.getLogDir() }

  installAsService (options) { return service.installAsService(options) }
  uninstallService (options) { return service.uninstallService(options) }
  isServiceInstalled (serviceName) { return service.isServiceInstalled(serviceName) }

  setupPrintInterception (config) { return network.setupPrintInterception(config) }
  teardownPrintInterception () { return network.teardownPrintInterception() }

  configureFirewall (rules) { return firewall.configureFirewall(rules) }

  getLocalIpAddresses () { return network.getLocalIpAddresses() }
  ensureIpAliasPersistent (originalIp, interfaceName) {
    return network.ensureIpAliasPersistent(originalIp, interfaceName)
  }

  logSystemEvent (level, message) { return logging.logSystemEvent(level, message) }
}

module.exports = WindowsAdapter
