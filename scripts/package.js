'use strict'

/**
 * scripts/package.js
 *
 * Assembles the offline installer layout consumed by install.bat:
 *
 *   <out>/
 *     install.bat
 *     uninstall.bat
 *     test-mode.bat
 *     test-printer.bat
 *     setup-helper.js
 *     test-printer.js
 *     config.json              <-- copied from config/config.example.json (operator must edit)
 *     agent/
 *       package.json
 *       package-lock.json
 *       src/
 *       node_modules/
 *     node/                    <-- only if --node-dir=PATH is provided
 *       node.exe + the rest of the portable distribution
 *     nssm.exe                 <-- only if --nssm=PATH (or scripts/nssm.exe / repo-root nssm.exe) is found
 *
 * Usage:
 *   node scripts/package.js [--out=PATH] [--node-dir=PATH] [--nssm=PATH] [--clean]
 *
 * Defaults:
 *   --out       dist\queue-manager-installer
 *   --clean     remove the output dir before building (default: false)
 *
 * Auto-pickup (no flags needed):
 *   vendor/node/      → bundled portable Node     (populated by `npm run vendor`)
 *   vendor/nssm.exe   → bundled NSSM              (populated by `npm run vendor`)
 *
 * Exit codes: 0 success, 1 failure.
 */

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SCRIPTS_DIR = __dirname
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor')
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist', 'queue-manager-installer')

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

function fail (msg) {
  process.stderr.write(`[package] ${msg}\n`)
  process.exit(1)
}

function note (msg) { process.stdout.write(`[package] ${msg}\n`) }

function copyTree (src, dst) {
  fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force: true })
}

function copyFile (src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function pickNssmPath (cliPath) {
  const candidates = [
    cliPath,
    process.env.QM_NSSM_PATH,
    path.join(VENDOR_DIR, 'nssm.exe'),
    path.join(SCRIPTS_DIR, 'nssm.exe'),
    path.join(REPO_ROOT, 'nssm.exe')
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function pickNodeDir (cliDir) {
  const candidates = [
    cliDir,
    process.env.QM_NODE_DIR,
    path.join(VENDOR_DIR, 'node')
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'node.exe'))) return c
  }
  return null
}

function main () {
  const flags = parseFlags(process.argv.slice(2))
  const out = path.resolve(flags.out || DEFAULT_OUT)

  // 1. Preflight
  const nodeModules = path.join(REPO_ROOT, 'node_modules')
  if (!fs.existsSync(nodeModules)) {
    fail('node_modules\\ missing — run "npm install" before packaging')
  }
  const example = path.join(REPO_ROOT, 'config', 'config.example.json')
  if (!fs.existsSync(example)) {
    fail(`config\\config.example.json not found at ${example}`)
  }
  const tessdata = path.join(REPO_ROOT, 'src', 'core', 'extractor', 'tessdata', 'eng.traineddata.gz')
  if (!fs.existsSync(tessdata)) {
    fail(
      'src\\core\\extractor\\tessdata\\eng.traineddata.gz missing — required for OCR to work offline.\n' +
      '          Run "npm run vendor" to fetch it, or check the file into the repo.\n' +
      '          (Without this, the installed agent will refuse to start OCR and raster orders will fall back to local serial numbers.)'
    )
  }

  // 2. Prepare output
  if (flags.clean && fs.existsSync(out)) {
    note(`cleaning ${out}`)
    fs.rmSync(out, { recursive: true, force: true })
  }
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(path.join(out, 'agent'), { recursive: true })

  // 3. Agent payload
  note('copying src/')
  copyTree(path.join(REPO_ROOT, 'src'), path.join(out, 'agent', 'src'))
  note('copying node_modules/ (this can take a minute)')
  copyTree(nodeModules, path.join(out, 'agent', 'node_modules'))
  copyFile(path.join(REPO_ROOT, 'package.json'), path.join(out, 'agent', 'package.json'))
  if (fs.existsSync(path.join(REPO_ROOT, 'package-lock.json'))) {
    copyFile(path.join(REPO_ROOT, 'package-lock.json'), path.join(out, 'agent', 'package-lock.json'))
  }

  // 4. Installer scripts at the package root
  note('copying installer scripts')
  for (const f of ['install.bat', 'uninstall.bat', 'test-mode.bat', 'test-printer.bat',
                   'setup-helper.js', 'test-printer.js']) {
    const src = path.join(SCRIPTS_DIR, f)
    if (!fs.existsSync(src)) fail(`missing installer file: scripts\\${f}`)
    copyFile(src, path.join(out, f))
  }

  // 5. config.json template (operator must edit before running install.bat)
  note('seeding config.json from config.example.json (operator MUST edit before install)')
  copyFile(example, path.join(out, 'config.json'))

  // 6. Optional: portable Node folder
  const nodeDir = pickNodeDir(flags['node-dir'])
  if (nodeDir) {
    note(`bundling portable Node from ${nodeDir}`)
    copyTree(nodeDir, path.join(out, 'node'))
  } else {
    note('no portable Node found (run "npm run vendor" or pass --node-dir=PATH); the technician will need system Node 20+ on the target machine')
  }

  // 7. Optional: nssm.exe
  const nssmPath = pickNssmPath(flags.nssm)
  if (nssmPath) {
    note(`bundling NSSM from ${nssmPath}`)
    copyFile(nssmPath, path.join(out, 'nssm.exe'))
  } else {
    note('no nssm.exe found; run "npm run vendor" or download from https://nssm.cc/download')
  }

  // 8. Final report
  const hasNode = fs.existsSync(path.join(out, 'node', 'node.exe'))
  const hasNssm = fs.existsSync(path.join(out, 'nssm.exe'))

  process.stdout.write('\n=================================\n')
  process.stdout.write('Queue Manager — installer package\n')
  process.stdout.write('=================================\n')
  process.stdout.write(`Output       : ${out}\n`)
  process.stdout.write(`Agent layout : ${path.join(out, 'agent')}\n`)
  process.stdout.write(`Bundled Node : ${hasNode ? 'yes' : 'NO — operator/installer needs system Node 20+'}\n`)
  process.stdout.write(`Bundled NSSM : ${hasNssm ? 'yes' : 'NO — drop nssm.exe next to install.bat before ship'}\n`)
  process.stdout.write(`config.json  : seeded from config.example.json (must be edited per restaurant)\n`)
  process.stdout.write('---------------------------------\n')
  process.stdout.write('Hand the entire output folder to the field technician.\n')
  process.stdout.write('They run install.bat as Administrator on the cashier PC.\n')
}

try { main() } catch (e) {
  process.stderr.write(`[package] uncaught: ${e.stack || e.message}\n`)
  process.exit(1)
}
