'use strict'

const { STATE_RANKS, TERMINAL_RANK } = require('./states')

function rankFor (status) {
  return STATE_RANKS[status]
}

function pickWinner (current, next) {
  if (!current) return next
  if (!next) return current
  if (next.status_rank === TERMINAL_RANK) return next
  if (current.status_rank === TERMINAL_RANK) return current
  return next.status_rank > current.status_rank ? next : current
}

module.exports = { rankFor, pickWinner, TERMINAL_RANK }
