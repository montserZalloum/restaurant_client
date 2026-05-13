'use strict'

const STATES = Object.freeze({
  PREPARING: 'preparing',
  READY: 'ready',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  CLEARED: 'cleared'
})

const STATE_RANKS = Object.freeze({
  [STATES.PREPARING]: 1,
  [STATES.READY]: 2,
  [STATES.DELIVERED]: 3,
  [STATES.CANCELLED]: 99,
  [STATES.CLEARED]: 99
})

const TERMINAL_RANK = 99

const ALL_STATES = new Set(Object.values(STATES))

function isTerminal (status) {
  return STATE_RANKS[status] === TERMINAL_RANK
}

module.exports = { STATES, STATE_RANKS, TERMINAL_RANK, ALL_STATES, isTerminal }
