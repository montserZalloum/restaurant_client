'use strict'

const http = require('http')

const PAGE_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Queue Manager — Test Mode</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, "Segoe UI", "Tahoma", sans-serif; max-width: 920px; margin: 1.2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; margin: 0 0 0.6rem; }
  h2 { font-size: 1rem; margin: 1.1rem 0 0.3rem; border-bottom: 1px solid currentColor; padding-bottom: 0.15rem; opacity: 0.9; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: baseline; }
  .label { opacity: 0.7; min-width: 9rem; display: inline-block; }
  .value { font-weight: 600; }
  pre { background: rgba(127,127,127,0.12); padding: 0.6rem; border-radius: 6px; overflow-x: auto; font-size: 13px; white-space: pre-wrap; word-break: break-all; max-height: 14rem; }
  .ok { color: #2a8c3a; }
  .bad { color: #b53a3a; }
  .muted { opacity: 0.7; }
  button { font: inherit; padding: 0.35rem 0.8rem; cursor: pointer; }
  .pill { display: inline-block; background: rgba(127,127,127,0.18); padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 12px; }
  .pin { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  .empty { opacity: 0.6; font-style: italic; }
</style>
</head>
<body>
<h1>Queue Manager — Test Mode</h1>
<div id="status" class="muted">Loading…</div>

<h2>Last Print</h2>
<div id="last-meta" class="muted empty">No print received yet.</div>
<div id="last-body"></div>

<h2 id="extract-h" style="display:none">Extraction</h2>
<div id="extract"></div>

<div style="margin-top:1.2rem; display:flex; gap:0.5rem;">
  <button id="refresh">Refresh now</button>
  <button id="clear">Clear last</button>
</div>

<script>
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]
  })
}
function formatAge(ms) {
  if (ms == null) return '—'
  var s = Math.round(ms / 1000)
  if (s < 60) return s + 's ago'
  var m = Math.round(s / 60)
  if (m < 60) return m + 'm ago'
  return Math.round(m / 60) + 'h ago'
}
function render(state) {
  var listening = state.listening || {}
  var statusEl = document.getElementById('status')
  var bind = (listening.host || '0.0.0.0') + ':' + (listening.port || '?')
  var aliasNote = listening.alias_ready ? '<span class="pill ok">alias ready</span>' : '<span class="pill bad">alias missing</span>'
  var receivedTotal = state.received_count || 0
  var uptimeS = state.started_at ? Math.round((Date.now() - state.started_at) / 1000) : 0
  statusEl.innerHTML = ''
    + '<div class="row"><span class="label">Listening:</span><span class="value pin">' + escapeHtml(bind) + '</span> ' + aliasNote + '</div>'
    + '<div class="row"><span class="label">Uptime:</span><span class="value">' + uptimeS + 's</span></div>'
    + '<div class="row"><span class="label">Total received:</span><span class="value">' + receivedTotal + '</span></div>'
  statusEl.classList.remove('muted')

  var meta = document.getElementById('last-meta')
  var body = document.getElementById('last-body')
  var extractH = document.getElementById('extract-h')
  var extract = document.getElementById('extract')
  if (!state.last) {
    meta.className = 'muted empty'
    meta.textContent = 'No print received yet.'
    body.innerHTML = ''
    extractH.style.display = 'none'
    extract.innerHTML = ''
    return
  }
  var l = state.last
  meta.className = ''
  meta.innerHTML = ''
    + '<div class="row"><span class="label">Received:</span><span class="value">' + escapeHtml(formatAge(Date.now() - l.received_at)) + '</span> <span class="muted pin">' + escapeHtml(new Date(l.received_at).toISOString()) + '</span></div>'
    + '<div class="row"><span class="label">Bytes:</span><span class="value">' + (l.bytes || 0) + '</span></div>'
    + '<div class="row"><span class="label">Source:</span><span class="value pin">' + escapeHtml(l.remote_ip || '—') + '</span></div>'

  var sections = []
  sections.push('<h3 style="font-size:0.95rem;margin:0.6rem 0 0.2rem">Hex (first 100 bytes)</h3><pre>' + escapeHtml(l.hex_preview || '') + '</pre>')
  if (l.decoded) {
    sections.push('<h3 style="font-size:0.95rem;margin:0.8rem 0 0.2rem">Decoded</h3>')
    var encs = ['utf-8', 'win1256', 'cp864']
    for (var i = 0; i < encs.length; i++) {
      var e = encs[i]
      var txt = l.decoded[e]
      if (txt == null) continue
      sections.push('<div class="muted" style="margin-top:0.4rem">' + escapeHtml(e) + ':</div><pre>' + escapeHtml(txt) + '</pre>')
    }
  }
  body.innerHTML = sections.join('')

  if (l.extraction) {
    extractH.style.display = ''
    var ex = l.extraction
    var html = ''
    html += '<div class="row"><span class="label">Regex:</span><span class="value pin">' + escapeHtml(ex.regex || '—') + '</span></div>'
    if (ex.rule_id) html += '<div class="row"><span class="label">Rule id:</span><span class="value pin">' + escapeHtml(ex.rule_id) + '</span></div>'
    if (ex.matched) {
      html += '<div class="row"><span class="label">Result:</span><span class="value ok">✓ matched (' + escapeHtml(ex.matched_encoding) + ')</span></div>'
      html += '<div class="row"><span class="label">Order number:</span><span class="value">' + escapeHtml(ex.order_number) + '</span></div>'
    } else {
      html += '<div class="row"><span class="label">Result:</span><span class="value bad">✗ no rule matched</span></div>'
    }
    if (ex.per_encoding && ex.per_encoding.length) {
      html += '<div class="muted" style="margin-top:0.4rem">Per-encoding test:</div><pre>'
      for (var j = 0; j < ex.per_encoding.length; j++) {
        var p = ex.per_encoding[j]
        html += escapeHtml((p.matched ? '✓' : '✗') + '  ' + p.encoding + (p.matched ? '  → ' + p.order_number : ''))
        html += '\\n'
      }
      html += '</pre>'
    }
    extract.innerHTML = html
  } else {
    extractH.style.display = 'none'
    extract.innerHTML = ''
  }
}

async function refresh() {
  try {
    var r = await fetch('/api/state', { cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    var state = await r.json()
    render(state)
  } catch (e) {
    document.getElementById('status').textContent = 'Error fetching state: ' + (e.message || e)
  }
}
async function clearLast() {
  try { await fetch('/api/clear', { method: 'POST' }) } catch (e) { /* ignore */ }
  refresh()
}
document.getElementById('refresh').addEventListener('click', refresh)
document.getElementById('clear').addEventListener('click', clearLast)
refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>
`

function sendJson (res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function makeHandler ({ getState, clearLast, logger }) {
  return (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      const pathname = url.pathname

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        return res.end(PAGE_HTML)
      }

      if (pathname === '/api/state') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'method_not_allowed' })
        }
        return sendJson(res, 200, getState())
      }

      if (pathname === '/api/clear') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed' })
        }
        clearLast()
        return sendJson(res, 200, { cleared: true })
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
    } catch (e) {
      if (logger && logger.warn) logger.warn('test-mode handler error', { err: e.message })
      try { res.writeHead(500, { 'Content-Type': 'text/plain' }).end('internal error') } catch { /* */ }
    }
  }
}

function createTestModeServer (deps) {
  return http.createServer(makeHandler(deps))
}

module.exports = { createTestModeServer, PAGE_HTML }
