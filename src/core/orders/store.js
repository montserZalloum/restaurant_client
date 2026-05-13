'use strict'

const { randomUUID } = require('crypto')
const { ALL_STATES, STATE_RANKS, TERMINAL_RANK } = require('./states')
const { pickWinner } = require('./rank')

const noopLogger = {
  debug () {}, info () {}, warn () {}, error () {}, critical () {},
  child () { return noopLogger }
}

class OrderStore {
  constructor ({ store, logger } = {}) {
    if (!store) throw new Error('OrderStore: store (JsonlStore) is required')
    this.store = store
    this.logger = logger || noopLogger
    this.orders = new Map()
    this.eventIds = new Set()
  }

  async load () {
    const events = await this.store.readAll()
    let applied = 0
    for (const ev of events) {
      if (this._applyInMemory(ev)) applied++
    }
    this.logger.info(`loaded ${this.orders.size} active orders from ${events.length} events (${applied} applied)`)
    return { totalEvents: events.length, ordersLoaded: this.orders.size }
  }

  _applyInMemory (event) {
    if (!event || !event.event_id || !event.order_id) return false
    if (this.eventIds.has(event.event_id)) return false
    this.eventIds.add(event.event_id)

    const current = this.orders.get(event.order_id)
    const winner = pickWinner(current, event)
    this.orders.set(event.order_id, winner)
    return winner === event
  }

  async applyEvent (event) {
    if (!event.status || !ALL_STATES.has(event.status)) {
      throw new Error(`invalid order status: ${event.status}`)
    }
    if (!event.event_id) event.event_id = randomUUID()
    if (!event.order_id) throw new Error('order_id is required')
    if (event.status_rank == null) event.status_rank = STATE_RANKS[event.status]
    if (!event.at) event.at = Date.now()

    const applied = this._applyInMemory(event)
    if (applied) await this.store.append(event)
    return applied
  }

  getOrder (orderId) {
    return this.orders.get(orderId)
  }

  getAllOrders () {
    return [...this.orders.values()]
  }

  getActiveOrders () {
    return [...this.orders.values()].filter(e => e.status_rank !== TERMINAL_RANK)
  }

  size () {
    return this.orders.size
  }

  async compact () {
    const kept = [...this.orders.values()].filter(e => e.status_rank !== TERMINAL_RANK)
    await this.store.rewrite(kept)
    this.eventIds = new Set(kept.map(r => r.event_id))
    const dropped = this.orders.size - kept.length
    for (const [id, ev] of this.orders) {
      if (ev.status_rank === TERMINAL_RANK) this.orders.delete(id)
    }
    this.logger.info(`compact: kept ${kept.length} active, dropped ${dropped} terminal`)
    return { kept: kept.length, dropped }
  }
}

module.exports = OrderStore
