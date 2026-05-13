'use strict'

/**
 * scripts/vendor-fetch.js
 *
 * Downloads pinned Node 20 portable for Windows + NSSM 2.24 into vendor/
 * so `npm run package` can produce a fully self-contained installer
 * without any external setup.
 *
 *   node scripts/vendor-fetch.js [--node=VERSION] [--force]
 *
 * Defaults:
 *   --node=20.18.0
 *   --force      re-download even if vendor/ already populated
 *
 * Output:
 *   vendor/node/             ← portable Node distribution (node.exe + npm + ...)
 *   vendor/nssm.exe          ← NSSM 2.24 (win64)
 *   vendor/.cache/           ← downloaded archives, kept for reuse on reruns
 *
 * Trust boundary:
 *   - Node : SHA256-verified against the SHASUMS256.txt published alongside
 *            the release on nodejs.org (canonical pattern).
 *   - NSSM : HTTPS only — nssm.cc does not publish per-release checksums.
 *            The script prints the SHA256 of the downloaded archive so the
 *            operator can pin/audit out of band if they want.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor')
const CACHE_DIR = path.join(VENDOR_DIR, '.cache')

const DEFAULT_NODE_VERSION = '20.18.0'
const NSSM_VERSION = '2.24'
const NSSM_URL = `https://nssm.cc/release/nssm-${NSSM_VERSION}.zip`

function parseFlags (argv) {
  const flags = {}
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else flags[a.slice(2)] = true
    }
  }
  return flags
}

function note (s) { process.stdout.write(`[vendor] ${s}\n`) }
function fail (s) { process.stderr.write(`[vendor] ${s}\n`); process.exit(1) }

function fetch (url, dst, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    const file = fs.createWriteStream(dst)
    const cleanup = () => { file.close(); try { fs.unlinkSync(dst) } catch {} }
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) queue-manager-vendor-fetch/1.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirects <= 0) { res.resume(); cleanup(); return reject(new Error(`too many redirects: ${url}`)) }
        const loc = res.headers.location
        res.resume()
        cleanup()
        return fetch(loc, dst, { redirects: redirects - 1 }).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        cleanup()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (e) => { try { fs.unlinkSync(dst) } catch {} ; reject(e) })
    }).on('error', (e) => { cleanup(); reject(e) })
  })
}

function fetchText (url, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) queue-manager-vendor-fetch/1.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirects <= 0) return reject(new Error(`too many redirects: ${url}`))
        const loc = res.headers.location
        res.resume()
        return fetchText(loc, { redirects: redirects - 1 }).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function sha256 (filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(filePath)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function expandZip (zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  // PowerShell Expand-Archive ships with Windows 10+ and is the most portable
  // way to unzip without bringing in a Node-side dependency.
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
  ], { stdio: 'inherit', windowsHide: true })
}

async function fetchNode (version, force) {
  const zipName = `node-v${version}-win-x64.zip`
  const zipUrl = `https://nodejs.org/dist/v${version}/${zipName}`
  const shasumsUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`
  const cacheZip = path.join(CACHE_DIR, zipName)
  const targetDir = path.join(VENDOR_DIR, 'node')

  if (!force && fs.existsSync(path.join(targetDir, 'node.exe'))) {
    note(`Node already at ${targetDir}\\node.exe — skipping (use --force to refetch)`)
    return targetDir
  }

  note(`fetching SHASUMS256.txt for Node v${version}`)
  const shasumsText = await fetchText(shasumsUrl)
  const lines = shasumsText.split(/\r?\n/)
  const expectedLine = lines.find((l) => l.endsWith('  ' + zipName))
  if (!expectedLine) fail(`SHASUMS256.txt does not list ${zipName}`)
  const expectedHash = expectedLine.split(/\s+/)[0]
  note(`expected SHA256 : ${expectedHash}`)

  let needDownload = true
  if (!force && fs.existsSync(cacheZip)) {
    const have = await sha256(cacheZip)
    if (have === expectedHash) {
      note(`reusing cached ${zipName}`)
      needDownload = false
    } else {
      note(`cached ${zipName} hash mismatch — re-downloading`)
      fs.unlinkSync(cacheZip)
    }
  }

  if (needDownload) {
    note(`downloading ${zipUrl} (~30 MB)`)
    await fetch(zipUrl, cacheZip)
    const got = await sha256(cacheZip)
    if (got !== expectedHash) {
      fs.unlinkSync(cacheZip)
      fail(`SHA256 mismatch for ${zipName}\n  got      : ${got}\n  expected : ${expectedHash}`)
    }
    note(`SHA256 verified`)
  }

  // Stage extraction in a temp dir, then flatten into vendor/node/.
  const stageDir = path.join(VENDOR_DIR, '.node-extract')
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true })
  note(`extracting Node`)
  expandZip(cacheZip, stageDir)

  const innerDir = path.join(stageDir, `node-v${version}-win-x64`)
  if (!fs.existsSync(innerDir)) fail(`extraction missing inner dir: ${innerDir}`)

  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(innerDir)) {
    fs.renameSync(path.join(innerDir, entry), path.join(targetDir, entry))
  }
  fs.rmSync(stageDir, { recursive: true, force: true })

  if (!fs.existsSync(path.join(targetDir, 'node.exe'))) {
    fail('extraction succeeded but node.exe missing')
  }
  note(`Node ready  : ${path.join(targetDir, 'node.exe')}`)
  return targetDir
}

async function fetchNssm (force) {
  const cacheZip = path.join(CACHE_DIR, `nssm-${NSSM_VERSION}.zip`)
  const targetExe = path.join(VENDOR_DIR, 'nssm.exe')

  if (!force && fs.existsSync(targetExe)) {
    note(`NSSM already at ${targetExe} — skipping (use --force to refetch)`)
    return targetExe
  }

  if (force || !fs.existsSync(cacheZip)) {
    note(`downloading ${NSSM_URL}`)
    await fetch(NSSM_URL, cacheZip)
  } else {
    note(`reusing cached nssm-${NSSM_VERSION}.zip`)
  }

  const archiveHash = await sha256(cacheZip)
  note(`NSSM zip SHA256 : ${archiveHash}  (HTTPS-only trust; no upstream checksum to pin)`)

  const stageDir = path.join(VENDOR_DIR, '.nssm-extract')
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true })
  note(`extracting NSSM`)
  expandZip(cacheZip, stageDir)

  const candidate = path.join(stageDir, `nssm-${NSSM_VERSION}`, 'win64', 'nssm.exe')
  if (!fs.existsSync(candidate)) fail(`NSSM extraction missing win64\\nssm.exe at ${candidate}`)
  fs.copyFileSync(candidate, targetExe)
  fs.rmSync(stageDir, { recursive: true, force: true })

  note(`NSSM ready  : ${targetExe}`)
  return targetExe
}

async function main () {
  const flags = parseFlags(process.argv.slice(2))
  const nodeVersion = flags.node || DEFAULT_NODE_VERSION
  const force = flags.force === true

  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  await fetchNode(nodeVersion, force)
  await fetchNssm(force)

  process.stdout.write('\n=================================\n')
  process.stdout.write('Queue Manager — vendor binaries ready\n')
  process.stdout.write('=================================\n')
  process.stdout.write(`Node : ${path.join(VENDOR_DIR, 'node', 'node.exe')}\n`)
  process.stdout.write(`NSSM : ${path.join(VENDOR_DIR, 'nssm.exe')}\n`)
  process.stdout.write('Next : npm run package\n')
}

main().catch((e) => {
  process.stderr.write(`[vendor] ${e.stack || e.message}\n`)
  process.exit(1)
})
