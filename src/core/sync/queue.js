'use strict'

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

class SyncQueue {
  constructor ({ store, logger } = {}) {
    if (!store) throw new Error('SyncQueue: store (JsonlStore) is required')
    this.store = store
    this.logger = logger || noopLogger
    this.events = []
    this.eventIds = new Set()
    this._chain = Promise.resolve()
  }

  async load () {
    const records = await this.store.readAll()
    this.events = []
    this.eventIds = new Set()
    for (const r of records) {
      if (!r || !r.event_id) continue
      if (this.eventIds.has(r.event_id)) continue
      this.events.push(r)
      this.eventIds.add(r.event_id)
    }
    this.logger.info(`sync queue loaded: ${this.events.length} pending events`)
    return this.events.length
  }

  async enqueue (event) {
    if (!event || !event.event_id) {
      throw new Error('SyncQueue.enqueue: event with event_id required')
    }
    if (this.eventIds.has(event.event_id)) {
      this.logger.debug('sync queue: duplicate event_id, ignoring', { event_id: event.event_id })
      return false
    }
    this.events.push(event)
    this.eventIds.add(event.event_id)
    await this._serialize(() => this.store.append(event))
    return true
  }

  peekBatch (limit) {
    if (!Number.isInteger(limit) || limit <= 0) limit = 50
    return this.events.slice(0, limit)
  }

  async ackBatch (eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return 0
    const acked = new Set(eventIds)
    const before = this.events.length
    this.events = this.events.filter(e => !acked.has(e.event_id))
    for (const id of acked) this.eventIds.delete(id)
    const removed = before - this.events.length
    if (removed > 0) {
      await this._serialize(() => this.store.rewrite(this.events))
    }
    return removed
  }

  size () {
    return this.events.length
  }

  _serialize (fn) {
    const next = this._chain.then(fn, fn)
    this._chain = next.then(() => {}, () => {})
    return next
  }
}

module.exports = SyncQueue
