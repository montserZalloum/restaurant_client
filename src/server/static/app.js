(() => {
  'use strict'

  const ENV = window.__ENV__ || {}
  const MODE = ENV.mode === 'cloud' ? 'cloud' : 'local'
  const LOCAL_WS = ENV.local_ws || (MODE === 'local' ? deriveLocalWs() : null)
  const CLOUD_WS = ENV.cloud_ws || null
  const CLOUD_BASE = ENV.cloud_base || (CLOUD_WS ? deriveCloudBase(CLOUD_WS) : null)
  const RESTAURANT_ID = ENV.restaurant_id || ''
  const RESTAURANT_NAME = ENV.restaurant_name || ''

  function deriveLocalWs () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/staff`
  }
  function deriveCloudBase (wsUrl) {
    try {
      const u = new URL(wsUrl)
      const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
      return `${proto}//${u.host}`
    } catch { return null }
  }

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel)
  const pinScreen = $('#pin-screen')
  const pinForm = $('#pin-form')
  const pinInput = $('#pin-input')
  const pinError = $('#pin-error')
  const pinSubmit = $('#pin-submit')
  const app = $('#app')
  const restaurantNameEl = $('#restaurant-name')
  const dotLocal = $('#dot-local')
  const dotCloud = $('#dot-cloud')
  const banner = $('#printer-banner')
  const listPreparing = $('#list-preparing')
  const listReady = $('#list-ready')
  const menuButton = $('#menu-button')
  const menuDropdown = $('#menu-dropdown')
  const modalOverlay = $('#modal-overlay')
  const modalTitle = $('#modal-title')
  const modalBody = $('#modal-body')
  const modalCancelBtn = $('#modal-cancel')
  const modalConfirmBtn = $('#modal-confirm')
  const toastContainer = $('#toast-container')

  // ---------- State ----------
  const MAX_BACKOFF_MS = 30000
  const MAX_SEEN_EVENTS = 200

  const channel = (name) => ({
    name,
    ws: null,
    status: 'absent',
    backoff: 1000,
    reconnectTimer: null
  })

  const state = {
    pin: localStorage.getItem('staff_pin') || '',
    preparing: new Map(),
    ready: new Map(),
    printerStatus: { status: 'ok', since: 0 },
    seenIds: [],
    seenSet: new Set(),
    local: channel('local'),
    cloud: channel('cloud')
  }

  if (!LOCAL_WS) state.local.status = 'absent'
  if (!CLOUD_WS) state.cloud.status = 'absent'
  setDot('local', state.local.status)
  setDot('cloud', state.cloud.status)

  if (RESTAURANT_NAME) restaurantNameEl.textContent = RESTAURANT_NAME

  // ---------- Boot ----------
  if (state.pin) {
    verifyAndStart(state.pin)
  } else {
    showPinScreen()
  }

  pinForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const pin = pinInput.value.trim()
    if (!/^\d{4,8}$/.test(pin)) {
      showPinError('PIN يجب أن يكون من 4 إلى 8 أرقام')
      return
    }
    pinSubmit.disabled = true
    pinError.hidden = true
    verifyAndStart(pin).finally(() => { pinSubmit.disabled = false })
  })

  function showPinScreen () {
    pinScreen.hidden = false
    app.hidden = true
    pinInput.value = ''
    setTimeout(() => pinInput.focus(), 50)
  }
  function showPinError (msg) {
    pinError.textContent = msg
    pinError.hidden = false
  }

  async function verifyAndStart (pin) {
    let ok
    try {
      ok = await verifyPin(pin)
    } catch (e) {
      showPinScreen()
      showPinError('تعذر التحقق من PIN — تحقق من الاتصال')
      return
    }
    if (!ok) {
      localStorage.removeItem('staff_pin')
      state.pin = ''
      showPinScreen()
      showPinError('PIN غير صحيح')
      return
    }
    state.pin = pin
    localStorage.setItem('staff_pin', pin)
    pinScreen.hidden = true
    app.hidden = false
    await bootstrapActiveOrders().catch(() => {})
    connectAll()
  }

  async function verifyPin (pin) {
    if (MODE === 'local') {
      const r = await fetch('/api/local/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      })
      if (r.status === 200) return true
      if (r.status === 401) return false
      throw new Error('unexpected_status_' + r.status)
    }
    if (!CLOUD_BASE) throw new Error('no_cloud_base')
    const r = await fetch(`${CLOUD_BASE}/api/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant_id: RESTAURANT_ID, pin })
    })
    if (r.status === 200) {
      try {
        const data = await r.json()
        if (data && data.restaurant_name && !RESTAURANT_NAME) {
          restaurantNameEl.textContent = data.restaurant_name
        }
      } catch { /* ignore */ }
      return true
    }
    if (r.status === 401) return false
    throw new Error('unexpected_status_' + r.status)
  }

  async function bootstrapActiveOrders () {
    const url = MODE === 'local'
      ? `/api/local/active-orders?pin=${encodeURIComponent(state.pin)}`
      : `${CLOUD_BASE}/api/staff/active-orders`
    const headers = MODE === 'local'
      ? { 'X-Staff-Pin': state.pin }
      : { 'X-Restaurant-Id': RESTAURANT_ID, 'X-Staff-Pin': state.pin }
    const r = await fetch(url, { headers })
    if (r.status === 401) {
      handleSessionInvalidated()
      return
    }
    if (!r.ok) throw new Error('http_' + r.status)
    const data = await r.json().catch(() => ({}))
    if (Array.isArray(data.orders)) replaceActiveOrders(data.orders)
  }

  // ---------- Connections ----------
  function connectAll () {
    if (LOCAL_WS) connectChannel(state.local, LOCAL_WS)
    else setDot('local', 'absent')
    if (CLOUD_WS) connectChannel(state.cloud, CLOUD_WS)
    else setDot('cloud', 'absent')
    if (!LOCAL_WS && !CLOUD_WS) toast('لا يوجد عنوان اتصال متاح', 'error')
  }

  function setDot (name, status) {
    const dot = name === 'local' ? dotLocal : dotCloud
    dot.dataset.state = status
  }

  function connectChannel (ch, baseUrl) {
    if (ch.reconnectTimer) {
      clearTimeout(ch.reconnectTimer)
      ch.reconnectTimer = null
    }
    let url
    try {
      const u = new URL(baseUrl)
      u.searchParams.set('pin', state.pin)
      if (ch.name === 'cloud' && RESTAURANT_ID) {
        u.searchParams.set('restaurant_id', RESTAURANT_ID)
      }
      url = u.toString()
    } catch (e) {
      ch.status = 'disconnected'
      setDot(ch.name, 'disconnected')
      return
    }

    ch.status = 'connecting'
    setDot(ch.name, 'connecting')

    let ws
    try { ws = new WebSocket(url) } catch (e) {
      ch.status = 'disconnected'
      setDot(ch.name, 'disconnected')
      scheduleReconnect(ch, baseUrl)
      return
    }
    ch.ws = ws

    ws.addEventListener('open', () => {
      ch.backoff = 1000
      ch.status = 'connected'
      setDot(ch.name, 'connected')
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      handleMessage(ch.name, msg)
    })
    ws.addEventListener('close', (ev) => {
      ch.status = 'disconnected'
      setDot(ch.name, 'disconnected')
      ch.ws = null
      if (ev.code === 4001 || ev.code === 4002 || ev.reason === 'pin_changed' || ev.reason === 'invalid_pin') {
        handleSessionInvalidated()
        return
      }
      scheduleReconnect(ch, baseUrl)
    })
    ws.addEventListener('error', () => {
      // close will follow
    })
  }

  function scheduleReconnect (ch, baseUrl) {
    if (ch.reconnectTimer) clearTimeout(ch.reconnectTimer)
    const delay = Math.min(ch.backoff, MAX_BACKOFF_MS)
    ch.reconnectTimer = setTimeout(() => {
      ch.backoff = Math.min(ch.backoff * 2, MAX_BACKOFF_MS)
      connectChannel(ch, baseUrl)
    }, delay)
  }

  function handleSessionInvalidated () {
    toast('انتهت الجلسة — أدخل PIN من جديد', 'error')
    closeAllChannels()
    localStorage.removeItem('staff_pin')
    state.pin = ''
    state.preparing.clear()
    state.ready.clear()
    render()
    showPinScreen()
  }

  function closeAllChannels () {
    for (const ch of [state.local, state.cloud]) {
      if (ch.reconnectTimer) clearTimeout(ch.reconnectTimer)
      ch.reconnectTimer = null
      ch.backoff = 1000
      if (ch.ws) {
        try { ch.ws.close() } catch { /* */ }
        ch.ws = null
      }
      ch.status = ch.name === 'local' && !LOCAL_WS ? 'absent'
        : ch.name === 'cloud' && !CLOUD_WS ? 'absent' : 'disconnected'
      setDot(ch.name, ch.status)
    }
  }

  // ---------- Inbound messages ----------
  function handleMessage (chName, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.event_id) {
      if (state.seenSet.has(msg.event_id)) return
      markSeen(msg.event_id)
    }
    switch (msg.type) {
      case 'active_orders':
        if (msg.data && Array.isArray(msg.data.orders)) {
          replaceActiveOrders(msg.data.orders)
        }
        break
      case 'order_event':
        applyOrderEvent(msg.data)
        break
      case 'clear_screen':
        applyClearScreen()
        break
      case 'printer_status':
        updatePrinterStatus(msg.data)
        break
      case 'pin_changed':
      case 'invalid_pin':
        handleSessionInvalidated()
        break
      case 'pong':
      case 'ping':
        break
      case 'error':
        // surface generic errors quietly
        break
      default:
        // ignore unknown
    }
  }

  function markSeen (id) {
    state.seenSet.add(id)
    state.seenIds.push(id)
    if (state.seenIds.length > MAX_SEEN_EVENTS) {
      const drop = state.seenIds.shift()
      state.seenSet.delete(drop)
    }
  }

  // ---------- Order state ----------
  function makeEntry (o) {
    return {
      order_id: o.order_id,
      order_number: o.order_number,
      extracted: o.extracted !== false,
      since: o.at || o.since || Date.now()
    }
  }

  function replaceActiveOrders (orders) {
    state.preparing.clear()
    state.ready.clear()
    for (const o of orders) {
      if (!o || !o.order_id) continue
      const entry = makeEntry(o)
      if (o.status === 'preparing') state.preparing.set(o.order_id, entry)
      else if (o.status === 'ready') state.ready.set(o.order_id, entry)
    }
    render()
  }

  function applyOrderEvent (ev) {
    if (!ev || !ev.order_id || !ev.status) return
    state.preparing.delete(ev.order_id)
    state.ready.delete(ev.order_id)
    if (ev.status === 'preparing') state.preparing.set(ev.order_id, makeEntry(ev))
    else if (ev.status === 'ready') state.ready.set(ev.order_id, makeEntry(ev))
    render()
  }

  function applyClearScreen () {
    state.preparing.clear()
    state.ready.clear()
    render()
  }

  function updatePrinterStatus (st) {
    if (!st) return
    state.printerStatus = st
    const failed = st.status && st.status !== 'ok'
    banner.hidden = !failed
  }

  // ---------- Render ----------
  function render () {
    renderColumn(listPreparing, state.preparing, 'preparing')
    renderColumn(listReady, state.ready, 'ready')
  }

  function renderColumn (listEl, map, kind) {
    const arr = [...map.values()].sort((a, b) => a.since - b.since)
    const frag = document.createDocumentFragment()
    for (const o of arr) frag.appendChild(buildCard(o, kind))
    listEl.replaceChildren(frag)
  }

  function buildCard (o, kind) {
    const li = document.createElement('li')
    li.className = 'order-card'
    li.dataset.orderId = o.order_id

    const num = document.createElement('div')
    num.className = 'order-number'
    num.textContent = (o.order_number != null) ? String(o.order_number) : '—'
    li.appendChild(num)

    if (o.extracted === false) {
      const flag = document.createElement('div')
      flag.className = 'order-fallback-flag'
      flag.textContent = '(غير مستخرج)'
      li.appendChild(flag)
    }

    const btn = document.createElement('button')
    btn.className = 'order-button' + (kind === 'ready' ? ' success' : '')
    btn.textContent = kind === 'preparing' ? 'جاهز' : 'تم التسليم'
    btn.addEventListener('click', () => {
      btn.disabled = true
      const fn = kind === 'preparing' ? markAsReady : markAsDelivered
      fn(o.order_id).finally(() => { btn.disabled = false })
    })
    li.appendChild(btn)
    return li
  }

  // ---------- Actions ----------
  async function markAsReady (orderId) {
    const o = state.preparing.get(orderId)
    if (!o) return
    state.preparing.delete(orderId)
    state.ready.set(orderId, o)
    render()
    try { await sendCommand(orderId, 'ready') } catch (e) {
      state.ready.delete(orderId)
      state.preparing.set(orderId, o)
      render()
      toast('فشل تحديث الطلب', 'error')
    }
  }

  async function markAsDelivered (orderId) {
    const o = state.ready.get(orderId)
    if (!o) return
    state.ready.delete(orderId)
    render()
    try { await sendCommand(orderId, 'delivered') } catch (e) {
      state.ready.set(orderId, o)
      render()
      toast('فشل تحديث الطلب', 'error')
    }
  }

  async function cancelOrder (orderId) {
    const original = state.preparing.get(orderId)
      ? { col: 'preparing', entry: state.preparing.get(orderId) }
      : state.ready.get(orderId)
        ? { col: 'ready', entry: state.ready.get(orderId) }
        : null
    if (!original) return
    state.preparing.delete(orderId)
    state.ready.delete(orderId)
    render()
    try { await sendCommand(orderId, 'cancelled') } catch (e) {
      // rollback to previous column
      if (original.col === 'preparing') state.preparing.set(orderId, original.entry)
      else state.ready.set(orderId, original.entry)
      render()
      toast('فشل الإلغاء', 'error')
    }
  }

  async function sendCommand (orderId, status) {
    const at = Date.now()
    const local = state.local.ws
    if (local && local.readyState === WebSocket.OPEN) {
      local.send(JSON.stringify({
        type: 'order_command',
        data: { order_id: orderId, status, at, pin: state.pin }
      }))
      return
    }
    if (!CLOUD_BASE) throw new Error('no_channel_available')
    const r = await fetch(`${CLOUD_BASE}/api/staff/orders/${encodeURIComponent(orderId)}/state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Restaurant-Id': RESTAURANT_ID,
        'X-Staff-Pin': state.pin
      },
      body: JSON.stringify({ status, at })
    })
    if (r.status === 401) { handleSessionInvalidated(); throw new Error('unauthorized') }
    if (!r.ok) throw new Error('http_' + r.status)
  }

  async function sendClearScreen () {
    const at = Date.now()
    const local = state.local.ws
    if (local && local.readyState === WebSocket.OPEN) {
      local.send(JSON.stringify({ type: 'clear_screen', data: { at, pin: state.pin } }))
      applyClearScreen()
      return
    }
    if (!CLOUD_BASE) throw new Error('no_channel_available')
    const r = await fetch(`${CLOUD_BASE}/api/staff/clear-screen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Restaurant-Id': RESTAURANT_ID,
        'X-Staff-Pin': state.pin
      },
      body: JSON.stringify({ at })
    })
    if (r.status === 401) { handleSessionInvalidated(); throw new Error('unauthorized') }
    if (!r.ok) throw new Error('http_' + r.status)
    applyClearScreen()
  }

  // ---------- Menu ----------
  menuButton.addEventListener('click', (e) => {
    e.stopPropagation()
    const willOpen = menuDropdown.hidden
    menuDropdown.hidden = !willOpen
    menuButton.setAttribute('aria-expanded', String(willOpen))
  })
  document.addEventListener('click', (e) => {
    if (menuDropdown.hidden) return
    if (!menuDropdown.contains(e.target) && e.target !== menuButton) {
      menuDropdown.hidden = true
      menuButton.setAttribute('aria-expanded', 'false')
    }
  })
  menuDropdown.addEventListener('click', (e) => {
    const action = e.target && e.target.dataset && e.target.dataset.action
    if (!action) return
    menuDropdown.hidden = true
    menuButton.setAttribute('aria-expanded', 'false')
    if (action === 'cancel') openCancelModal()
    else if (action === 'clear') openClearModal()
    else if (action === 'logout') logout()
  })

  function openCancelModal () {
    const items = [...state.preparing.values(), ...state.ready.values()]
      .sort((a, b) => a.since - b.since)
    if (!items.length) { toast('لا توجد طلبات نشطة', 'info'); return }
    const list = document.createElement('div')
    list.className = 'modal-list'
    for (const o of items) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'order-pick'
      btn.textContent = '#' + (o.order_number != null ? o.order_number : '—')
      btn.addEventListener('click', () => {
        closeModal()
        confirmCancel(o)
      })
      list.appendChild(btn)
    }
    showModal({
      title: 'إلغاء طلب',
      bodyNode: list,
      hideConfirm: true,
      cancelText: 'إغلاق'
    })
  }

  function confirmCancel (order) {
    showModal({
      title: 'تأكيد الإلغاء',
      bodyText: `سيتم إلغاء الطلب رقم ${order.order_number}.`,
      confirmText: 'إلغاء الطلب',
      confirmClass: 'danger',
      onConfirm: () => cancelOrder(order.order_id)
    })
  }

  function openClearModal () {
    const total = state.preparing.size + state.ready.size
    if (total === 0) { toast('لا توجد طلبات نشطة', 'info'); return }
    showModal({
      title: 'تصفير الشاشة',
      bodyText: `سيتم إزالة ${total} طلب نشط. لا يمكن التراجع.`,
      confirmText: 'متابعة',
      onConfirm: () => {
        showModal({
          title: 'تأكيد أخير',
          bodyText: 'اضغط "تصفير الآن" للتأكيد النهائي.',
          confirmText: 'تصفير الآن',
          confirmClass: 'danger',
          onConfirm: async () => {
            try { await sendClearScreen() } catch (e) { toast('فشل التصفير', 'error') }
          }
        })
      }
    })
  }

  function logout () {
    closeAllChannels()
    localStorage.removeItem('staff_pin')
    state.pin = ''
    state.preparing.clear()
    state.ready.clear()
    render()
    banner.hidden = true
    showPinScreen()
  }

  // ---------- Modal ----------
  let modalOnConfirm = null
  function showModal ({ title, bodyText, bodyNode, confirmText, confirmClass, hideConfirm, cancelText, onConfirm }) {
    modalTitle.textContent = title || ''
    modalBody.replaceChildren()
    if (bodyNode) {
      modalBody.appendChild(bodyNode)
    } else if (bodyText) {
      const p = document.createElement('p')
      p.textContent = bodyText
      modalBody.appendChild(p)
    }
    modalConfirmBtn.textContent = confirmText || 'تأكيد'
    modalConfirmBtn.className = 'modal-confirm' + (confirmClass ? ' ' + confirmClass : '')
    modalConfirmBtn.hidden = !!hideConfirm
    modalCancelBtn.textContent = cancelText || 'إلغاء'
    modalOnConfirm = onConfirm || null
    modalOverlay.hidden = false
  }
  function closeModal () {
    modalOverlay.hidden = true
    modalOnConfirm = null
  }
  modalCancelBtn.addEventListener('click', closeModal)
  modalConfirmBtn.addEventListener('click', () => {
    const fn = modalOnConfirm
    closeModal()
    if (fn) Promise.resolve(fn()).catch(() => {})
  })
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modalOverlay.hidden) closeModal()
      else if (!menuDropdown.hidden) {
        menuDropdown.hidden = true
        menuButton.setAttribute('aria-expanded', 'false')
      }
    }
  })

  // ---------- Toast ----------
  function toast (text, kind) {
    const el = document.createElement('div')
    el.className = 'toast' + (kind ? ' ' + kind : '')
    el.textContent = text
    toastContainer.appendChild(el)
    setTimeout(() => { el.remove() }, 3500)
  }

  // ---------- Window events ----------
  window.addEventListener('online', () => {
    if (!state.pin) return
    for (const ch of [state.local, state.cloud]) {
      const url = ch.name === 'local' ? LOCAL_WS : CLOUD_WS
      if (!url) continue
      if (!ch.ws || ch.ws.readyState !== WebSocket.OPEN) {
        ch.backoff = 1000
        if (ch.reconnectTimer) clearTimeout(ch.reconnectTimer)
        ch.reconnectTimer = null
        connectChannel(ch, url)
      }
    }
  })
})()
