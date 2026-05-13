'use strict'

const path = require('path')

const ROOT = process.env.QM_DATA_ROOT
  || (process.env.PROGRAMDATA
        ? path.join(process.env.PROGRAMDATA, 'QueueManager')
        : path.join('C:', 'ProgramData', 'QueueManager'))

const LOG_DIR = process.env.QM_LOG_DIR || path.join(ROOT, 'logs')

module.exports = {
  getRoot: () => ROOT,
  getDataDir: () => path.join(ROOT, 'data'),
  getConfigDir: () => path.join(ROOT, 'config'),
  getLogDir: () => LOG_DIR
}
