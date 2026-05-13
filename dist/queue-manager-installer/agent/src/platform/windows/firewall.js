'use strict'

const { execFileSync } = require('child_process')

const NETSH = 'netsh'

const RULE_PRINT_RECEIVER = 'Queue Manager - Print Receiver'
const RULE_LOCAL_SERVER = 'Queue Manager - Local Server'
const RULE_CLOUD_CONNECTION = 'Queue Manager - Cloud Connection'
const RULE_TEST_MODE = 'Queue Manager - Test Mode (Temporary)'

function runNetsh (args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(NETSH, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, stdout: out.toString('utf8') }
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString('utf8')) || ''
    const stdout = (e.stdout && e.stdout.toString('utf8')) || ''
    if (allowFail) return { ok: false, code: e.status, stderr, stdout }
    const detail = stderr || stdout || e.message
    const err = new Error(`netsh failed (${e.status}): ${detail.trim()}`)
    err.code = e.status
    err.stderr = stderr
    err.stdout = stdout
    throw err
  }
}

function ruleExists (name) {
  if (typeof name !== 'string' || !name) {
    throw new Error('ruleExists: name required')
  }
  const r = runNetsh(
    ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`],
    { allowFail: true }
  )
  return r.ok && /Rule Name|اسم القاعدة/i.test(r.stdout)
}

function addRule (rule) {
  if (!rule || typeof rule !== 'object') {
    throw new Error('addRule: rule object required')
  }
  if (!rule.name) throw new Error('addRule: rule.name required')
  if (!rule.dir) throw new Error('addRule: rule.dir required (in|out)')

  const args = [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${rule.name}`,
    `dir=${rule.dir}`,
    `action=${rule.action || 'allow'}`,
    `protocol=${rule.protocol || 'TCP'}`
  ]
  if (rule.localport != null) args.push(`localport=${rule.localport}`)
  if (rule.remoteport != null) args.push(`remoteport=${rule.remoteport}`)
  if (rule.profile) args.push(`profile=${rule.profile}`)
  if (rule.description) args.push(`description=${rule.description}`)

  runNetsh(args)
  return { added: true, name: rule.name }
}

function deleteRule (name) {
  if (typeof name !== 'string' || !name) {
    throw new Error('deleteRule: name required')
  }
  const r = runNetsh(
    ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`],
    { allowFail: true }
  )
  return { deleted: r.ok, name }
}

function ensureRule (rule) {
  if (ruleExists(rule.name)) return { ensured: true, name: rule.name, alreadyExisted: true }
  addRule(rule)
  return { ensured: true, name: rule.name, alreadyExisted: false }
}

function configureFirewall (rules) {
  const add = (rules && rules.add) || []
  const remove = (rules && rules.remove) || []
  const results = { added: [], removed: [], errors: [] }

  for (const rule of add) {
    try { results.added.push(ensureRule(rule)) } catch (e) {
      results.errors.push({ rule: rule.name, action: 'add', error: e.message })
    }
  }
  for (const name of remove) {
    try { results.removed.push(deleteRule(name)) } catch (e) {
      results.errors.push({ rule: name, action: 'remove', error: e.message })
    }
  }
  return results
}

const DEFAULT_RULES = {
  print_receiver: {
    name: RULE_PRINT_RECEIVER,
    dir: 'in',
    action: 'allow',
    protocol: 'TCP',
    localport: 9100,
    profile: 'private'
  },
  local_server: {
    name: RULE_LOCAL_SERVER,
    dir: 'in',
    action: 'allow',
    protocol: 'TCP',
    localport: 9200,
    profile: 'private'
  },
  cloud_connection: {
    name: RULE_CLOUD_CONNECTION,
    dir: 'out',
    action: 'allow',
    protocol: 'TCP',
    remoteport: 443,
    profile: 'private'
  },
  test_mode: {
    name: RULE_TEST_MODE,
    dir: 'in',
    action: 'allow',
    protocol: 'TCP',
    localport: 9300,
    profile: 'private'
  }
}

function buildDefaultRules ({ printPort = 9100, localPort = 9200 } = {}) {
  return [
    { ...DEFAULT_RULES.print_receiver, localport: printPort },
    { ...DEFAULT_RULES.local_server, localport: localPort },
    { ...DEFAULT_RULES.cloud_connection }
  ]
}

module.exports = {
  configureFirewall,
  addRule,
  deleteRule,
  ensureRule,
  ruleExists,
  buildDefaultRules,
  DEFAULT_RULES,
  RULE_PRINT_RECEIVER,
  RULE_LOCAL_SERVER,
  RULE_CLOUD_CONNECTION,
  RULE_TEST_MODE
}
