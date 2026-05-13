'use strict'

const { execFileSync } = require('child_process')

const DEFAULT_SERVICE_NAME = 'QueueManager'

function runCmd (cmd, args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { ok: true, stdout: out.toString('utf8') }
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString('utf8')) || ''
    const stdout = (e.stdout && e.stdout.toString('utf8')) || ''
    if (allowFail) return { ok: false, code: e.status, stderr, stdout }
    const detail = stderr || stdout || e.message
    const err = new Error(`${cmd} failed (${e.status}): ${detail.trim()}`)
    err.code = e.status
    err.stderr = stderr
    err.stdout = stdout
    throw err
  }
}

function isServiceInstalled (serviceName = DEFAULT_SERVICE_NAME) {
  const r = runCmd('sc', ['query', serviceName], { allowFail: true })
  if (!r.ok) return false
  return /SERVICE_NAME:|SERVICE TYPE/i.test(r.stdout)
}

function getServiceState (serviceName = DEFAULT_SERVICE_NAME) {
  const r = runCmd('sc', ['queryex', serviceName], { allowFail: true })
  if (!r.ok) return { exists: false, state: null, pid: null }
  const stateMatch = r.stdout.match(/STATE\s*:\s*\d+\s+(\w+)/)
  const pidMatch = r.stdout.match(/PID\s*:\s*(\d+)/)
  return {
    exists: true,
    state: stateMatch ? stateMatch[1].toUpperCase() : 'UNKNOWN',
    pid: pidMatch ? Number(pidMatch[1]) : null
  }
}

function nssm (nssmPath, args, options) {
  if (!nssmPath) throw new Error('nssm path required')
  return runCmd(nssmPath, args, options)
}

function nssmSet (nssmPath, serviceName, key, ...values) {
  return nssm(nssmPath, ['set', serviceName, key, ...values])
}

function buildEnvPairs (env) {
  if (!env || typeof env !== 'object') return []
  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}

function setRecovery (serviceName, recovery) {
  if (!recovery) return { applied: false }
  const r1 = (recovery.first_failure_delay_sec || 5) * 1000
  const r2 = (recovery.second_failure_delay_sec || 10) * 1000
  const r3 = (recovery.third_failure_delay_sec || 20) * 1000
  const periodSeconds = (recovery.failure_period_minutes || 30) * 60
  // sc.exe failure ServiceName reset= <secs> actions= restart/<ms>/restart/<ms>/restart/<ms>
  runCmd('sc', [
    'failure', serviceName,
    `reset=`, String(periodSeconds),
    `actions=`, `restart/${r1}/restart/${r2}/restart/${r3}`
  ])
  return { applied: true, periodSeconds, delaysMs: [r1, r2, r3] }
}

function startService (serviceName = DEFAULT_SERVICE_NAME) {
  return runCmd('net', ['start', serviceName], { allowFail: true })
}

function stopService (serviceName = DEFAULT_SERVICE_NAME) {
  return runCmd('net', ['stop', serviceName], { allowFail: true })
}

// Non-blocking sc-stop with polling. `net stop` blocks indefinitely if the
// service doesn't acknowledge SCM, so installs hang on the first hung agent.
// We kick off the stop with `sc stop` (returns immediately), poll `sc queryex`
// until STOPPED or the deadline, then taskkill the PID as last resort.
function stopServiceWithTimeout (serviceName = DEFAULT_SERVICE_NAME, timeoutMs = 30000) {
  if (!isServiceInstalled(serviceName)) {
    return { stopped: false, reason: 'not_installed' }
  }

  const initial = getServiceState(serviceName)
  if (initial.state === 'STOPPED') {
    return { stopped: true, alreadyStopped: true }
  }

  runCmd('sc', ['stop', serviceName], { allowFail: true })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = getServiceState(serviceName)
    if (!s.exists || s.state === 'STOPPED') {
      return { stopped: true, forced: false }
    }
  }

  const final = getServiceState(serviceName)
  if (final.exists && final.state !== 'STOPPED' && final.pid) {
    runCmd('taskkill', ['/F', '/PID', String(final.pid)], { allowFail: true })
    const killDeadline = Date.now() + 3000
    while (Date.now() < killDeadline) {
      const s2 = getServiceState(serviceName)
      if (!s2.exists || s2.state === 'STOPPED') {
        return { stopped: true, forced: true, pid: final.pid }
      }
    }
  }

  return { stopped: false, reason: 'timeout', state: final.state, pid: final.pid }
}

function installAsService (options = {}) {
  const {
    nssmPath,
    nodePath,
    scriptPath,
    appDirectory,
    serviceName = DEFAULT_SERVICE_NAME,
    displayName,
    description,
    env,
    stdoutLog,
    stderrLog,
    restartDelayMs = 5000,
    appThrottleMs = 1500,
    recovery,
    autoStart = true
  } = options

  if (!nssmPath) throw new Error('installAsService: nssmPath required')
  if (!nodePath) throw new Error('installAsService: nodePath required')
  if (!scriptPath) throw new Error('installAsService: scriptPath required')

  if (isServiceInstalled(serviceName)) {
    throw new Error(`service ${serviceName} already installed — uninstall first`)
  }

  nssm(nssmPath, ['install', serviceName, nodePath, scriptPath])

  if (appDirectory) nssmSet(nssmPath, serviceName, 'AppDirectory', appDirectory)
  if (displayName) nssmSet(nssmPath, serviceName, 'DisplayName', displayName)
  if (description) nssmSet(nssmPath, serviceName, 'Description', description)
  if (stdoutLog) nssmSet(nssmPath, serviceName, 'AppStdout', stdoutLog)
  if (stderrLog) nssmSet(nssmPath, serviceName, 'AppStderr', stderrLog)

  const envPairs = buildEnvPairs(env)
  if (envPairs.length) {
    nssmSet(nssmPath, serviceName, 'AppEnvironmentExtra', ...envPairs)
  }

  nssmSet(nssmPath, serviceName, 'AppRestartDelay', String(restartDelayMs))
  nssmSet(nssmPath, serviceName, 'AppThrottle', String(appThrottleMs))
  nssmSet(nssmPath, serviceName, 'AppExit', 'Default', 'Restart')
  nssmSet(nssmPath, serviceName, 'Start', autoStart ? 'SERVICE_AUTO_START' : 'SERVICE_DEMAND_START')

  let recoveryResult = null
  try { recoveryResult = setRecovery(serviceName, recovery) } catch (e) {
    // sc.exe failure is best-effort — NSSM AppExit already covers basic restart
    recoveryResult = { applied: false, error: e.message }
  }

  return {
    installed: true,
    serviceName,
    nodePath,
    scriptPath,
    appDirectory: appDirectory || null,
    recovery: recoveryResult
  }
}

function uninstallService (options = {}) {
  const {
    nssmPath,
    serviceName = DEFAULT_SERVICE_NAME,
    stopTimeoutMs = 30000
  } = options

  if (!nssmPath) throw new Error('uninstallService: nssmPath required')

  if (!isServiceInstalled(serviceName)) {
    return { uninstalled: false, reason: 'not_installed' }
  }

  const stopResult = stopServiceWithTimeout(serviceName, stopTimeoutMs)

  nssm(nssmPath, ['remove', serviceName, 'confirm'])

  return { uninstalled: true, serviceName, stop: stopResult }
}

module.exports = {
  installAsService,
  uninstallService,
  isServiceInstalled,
  getServiceState,
  startService,
  stopService,
  stopServiceWithTimeout,
  setRecovery,
  DEFAULT_SERVICE_NAME
}
