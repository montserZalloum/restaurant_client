'use strict'

const fs = require('fs').promises
const { existsSync } = require('fs')
const path = require('path')

class JsonlStore {
  constructor (filePath) {
    if (!filePath) throw new Error('JsonlStore: filePath is required')
    this.filePath = filePath
  }

  async _ensureFile () {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    if (!existsSync(this.filePath)) {
      await fs.writeFile(this.filePath, '', 'utf8')
    }
  }

  async append (record) {
    await this._ensureFile()
    await fs.appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8')
  }

  async readAll () {
    await this._ensureFile()
    const raw = await fs.readFile(this.filePath, 'utf8')
    if (!raw) return []
    const out = []
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // Skip malformed line — partial corruption must not kill startup.
        // Periodic rewrite (PRD #2) will purge them.
      }
    }
    return out
  }

  async readWhere (predicate) {
    const all = await this.readAll()
    return all.filter(predicate)
  }

  async rewrite (records) {
    await this._ensureFile()
    const tmp = this.filePath + '.tmp'
    const content = records.length
      ? records.map(r => JSON.stringify(r)).join('\n') + '\n'
      : ''
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async count () {
    const all = await this.readAll()
    return all.length
  }
}

module.exports = JsonlStore
