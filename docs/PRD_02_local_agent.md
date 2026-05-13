# PRD #2: البرنامج المحلي (Local Agent)

> **الغرض من هذا المستند:** تحديد متطلبات البرنامج المحلي الذي يعمل على جهاز الكاشير. هذا هو القلب التشغيلي للنظام — يعترض الطباعة، يعالج الطلبات، يزامنها مع السحابة، ويخدم اتصالات الموظف المحلية.

> **المرجعيات:**
> - `decisions_session_01.md`: أقسام ٢.٢، ٢.٣، ٢.٤، ٢.٥، ٢.٦، ٣.٣
> - `decisions_session_02.md`: أقسام ٢.١، ٢.٢، ٣.١، ٣.٤، ٣.٥، ٣.٦، ٥ (Promise.race)
> - `decisions_session_03.md`: أقسام ٢.٤، ٢.٧
> - `decisions_session_04.md`: قسم ٦.٢
> - `decisions_session_05.md`: قسم ٣.٢

> **النسخة:** 1.1 — تعديلات لدعم Promise.race لصفحة الموظف (إضافة قسم خادم WebSocket المحلي).

> **التبعية على PRD سابق:** هذا الـ PRD يفترض أن PRD #1 مكتمل (بنية المجلدات، `PlatformAdapter`، `JsonlStore`، `config.json`).

---

## ١. النطاق

### ١.١ ما يشمله هذا الـ PRD

- استقبال بيانات الطباعة من الكاشير (TCP server)
- التمرير الفوري للطابعة الحقيقية مع آلية إعادة المحاولة
- استخراج رقم الطلب من بيانات الفاتورة
- إدارة حالات الطلبات محلياً (preparing, ready, delivered, cancelled, cleared)
- تطبيق منطق State Rank Wins
- التخزين في `active_orders.jsonl` و `sync_queue.jsonl`
- مزامنة الطلبات مع السحابة + إبلاغها بـ LAN IP
- استقبال تحديثات الحالة من السحابة (مزامنة عكسية)
- **خادم WebSocket محلي للموظف** (جديد في النسخة 1.1)
  - مصادقة بـ PIN
  - استقبال أوامر الموظف (mark_ready, mark_delivered, cancel, clear_screen)
  - بث أحداث الطلبات وحالة الطابعة
- استعادة الحالة بعد إعادة التشغيل

### ١.٢ ما هو خارج النطاق

- إعداد Windows Service (PRD #7)
- إعداد IP alias الفعلي في الشبكة (PRD #7)
- لوحة تحكم سحابية (PRD #6)
- صفحة الموظف وصفحة الشاشة (PRDs #5، #4)
- API السحابي (PRD #3)

### ١.٣ المبدأ الجوهري الموجِّه

> **أي طلب يصل للبرنامج المحلي يُعالج بشكل طبيعي وكامل، بغض النظر عن أي ظروف خارجية.**

(من `decisions_session_02.md` بند ٣.١)

---

## ٢. نظرة معمارية شاملة

### ٢.١ تدفق البيانات الرئيسي

```
┌─────────────────────────────────────────────────────────────┐
│                    جهاز الكاشير (Windows)                   │
│                                                             │
│  ┌─────────┐                                                │
│  │ الكاشير │ ─→ TCP إلى printer_old_ip:9100                │
│  └─────────┘                                                │
│                ↓                                            │
│  ┌────────────────────────────────────────────┐             │
│  │              Local Agent                   │             │
│  │                                            │             │
│  │  ┌──────────────────────────────────────┐  │             │
│  │  │ TCP Server (Interceptor)             │  │             │
│  │  └─────┬──────────────────┬─────────────┘  │             │
│  │        │ (متوازي)          │                │             │
│  │        ↓                   ↓                │             │
│  │  ┌──────────┐        ┌─────────────┐       │             │
│  │  │ تمرير    │        │ معالجة الطلب │       │           │
│  │  │ للطابعة  │        │ + استخراج    │       │             │
│  │  └────┬─────┘        └──────┬───────┘       │             │
│  │       │                     │                │             │
│  │       ↓                     ↓                │             │
│  │  ┌──────────┐        ┌─────────────┐       │             │
│  │  │ الطابعة  │        │ JSONL +     │       │             │
│  │  └──────────┘        │ Sync Queue  │       │             │
│  │                       └──────┬──────┘       │             │
│  │                              │              │             │
│  │       ┌──────────────────────┼──────┐       │             │
│  │       ↓                      ↓      ↓       │             │
│  │  ┌─────────┐         ┌─────────┐ ┌────────┐ │           │
│  │  │ Cloud   │         │ Local   │ │ Cloud  │ │           │
│  │  │ Sync    │         │ WS      │ │ WS     │ │           │
│  │  │ Client  │         │ Server  │ │ Client │ │           │
│  │  └────┬────┘         └────┬────┘ └────┬───┘ │           │
│  │       │                   │            │     │           │
│  └───────┼───────────────────┼────────────┼─────┘           │
│          │                   │            │                 │
└──────────┼───────────────────┼────────────┼─────────────────┘
           ↓                   ↓            ↓
   ┌──────────────┐   ┌─────────────┐  ┌──────────────┐
   │   السحابة   │   │ موبايل      │  │ السحابة      │
   │ (HTTP API)   │   │ الموظف      │  │ (WebSocket)  │
   └──────────────┘   │ (محلياً)     │  └──────────────┘
                      └─────────────┘
```

### ٢.٢ مبدأ التوازي

التمرير للطابعة ومعالجة الطلب **يبدآن متوازيَين** بمجرد استقبال البيانات.

### ٢.٣ مبدأ Promise.race لصفحة الموظف

(من `decisions_session_02.md` بند ٥)

البرنامج المحلي يخدم اتصالات WebSocket من موبايل الموظف **بنفس الـ contract** الذي تستخدمه السحابة. هذا يسمح لصفحة الموظف بفتح اتصالين متوازيين:

```
صفحة الموظف
    ├─→ WebSocket للسحابة (wss://api.queue-manager.com/ws/staff)
    └─→ WebSocket للبرنامج المحلي (ws://192.168.1.5:9200)
       
استخدام Promise.race:
  - لو الموظف على واي فاي المطعم: المحلي يفوز (سرعة)
  - لو الموظف على بيانات خلوية: السحابي يفوز (المحلي غير متاح)
  - لو الإنترنت قطع: المحلي وحده يعمل، النظام لا يتعطل
```

**الميزة الجوهرية:** المطعم لا يتعطل عند انقطاع الإنترنت، انسجاماً مع المبدأ الموجِّه.

---

## ٣. المكوّن: TCP Server (Interceptor)

### ٣.١ الوظيفة

استقبال بيانات الطباعة الخام من الكاشير على `config.network.printer_old_ip:config.network.printer_port`.

### ٣.٢ المتطلبات الوظيفية

#### ٣.٢.١ الاستماع

- يفتح TCP server على `0.0.0.0:9100`
- يقبل اتصالات من `config.network.cashier_ip` فقط
- أي IP آخر = يُرفض ويُسجَّل warn

#### ٣.٢.٢ القراءة

- يقرأ البيانات الخام من الـ socket
- نهاية البيانات: إغلاق الكاشير الاتصال أو timeout 500ms على آخر byte
- الحد الأقصى: 64 KB

#### ٣.٢.٣ التمرير الفوري (الأولوية القصوى)

بمجرد استقبال أول chunk:
- فتح TCP إلى `printer_new_ip:printer_port`
- streaming للبيانات (لا انتظار اكتمال)
- آخر byte من الكاشير → آخر byte للطابعة: < 10ms

#### ٣.٢.٤ آلية إعادة المحاولة

(من `decisions_session_02.md` بند ٣.٤)

```
المحاولة 1 → فشل → انتظار 200ms
المحاولة 2 → فشل → انتظار 200ms
المحاولة 3 → فشل → الفشل مؤكد
```

عند فشل المحاولات الثلاث:
- يُسجَّل error
- يُبَث `printer_status: failed` على WebSocket المحلي والسحابي
- **الطلب يُعالج بشكل طبيعي** (لا توقف، لا حذف)

#### ٣.٢.٥ التوازي

- طلبات متعددة → تُعالج بشكل متوازي
- لا queue، لا قفل

---

## ٤. المكوّن: Order Extractor

### ٤.١ مكتبة قواعد Regex

`config/rules-library.json`:

```json
{
  "version": 1,
  "rules": [
    { "id": "rule_arabic_v1", "regex": "رقم الطلب:?\\s*(\\d+)" },
    { "id": "rule_english_order", "regex": "Order\\s*#\\s*(\\d+)" },
    { "id": "rule_english_number", "regex": "Order\\s*Number:?\\s*(\\d+)" },
    { "id": "rule_receipt", "regex": "Receipt\\s*#\\s*(\\d+)" },
    { "id": "rule_invoice", "regex": "Invoice\\s*#\\s*(\\d+)" }
  ]
}
```

### ٤.٢ آلية العمل

١. تحويل البيانات الخام لنص بمحاولة فك ترميز:
   - UTF-8 → Windows-1256 → CP864 (باستخدام `iconv-lite`)
٢. تطبيق الـ regex المثبّت من `config.extractor.regex`
٣. عند النجاح: استخراج الرقم
٤. عند الفشل: استخدام رقم تسلسلي محلي (يُعلَّم بـ `extracted: false`)

### ٤.٣ أداة "تثبيت القاعدة"

`scripts/test-rules.js`:
- يقرأ نصوص فواتير حقيقية
- يجرّب كل القواعد
- يعرض النتائج
- الفني يختار → تُكتَب في `config.json`

---

## ٥. المكوّن: Order State Manager

### ٥.١ الحالات

```javascript
const STATES = {
  PREPARING: { name: 'preparing', rank: 1 },
  READY:     { name: 'ready',     rank: 2 },
  DELIVERED: { name: 'delivered', rank: 3 },
  CANCELLED: { name: 'cancelled', rank: 99 },
  CLEARED:   { name: 'cleared',   rank: 99 }
}
```

### ٥.٢ تركيب سجل الطلب

```json
{
  "id": "uuid-v4",
  "order_number": 47,
  "extracted": true,
  "status": "ready",
  "status_rank": 2,
  "history": [
    { "status": "preparing", "at": 1746345600000, "synced": true, "source": "local" },
    { "status": "ready", "at": 1746345900000, "synced": true, "source": "staff_local" }
  ],
  "raw_data_size": 487,
  "created_at": 1746345600000,
  "last_updated": 1746345900000
}
```

`source` يكون:
- `local` — من الكاشير (الافتراضي)
- `staff_local` — من الموظف عبر WebSocket المحلي
- `staff_cloud` — من الموظف عبر السحابة
- `cloud` — من السحابة (تحديث من موظف آخر مثلاً)

### ٥.٣ منطق State Rank Wins

```javascript
function applyStateChange(currentState, newState) {
  if (newState.rank === 99) return newState  // إلغاء/تصفير يفوز
  if (newState.rank > currentState.rank) return newState
  return currentState
}
```

### ٥.٤ الأحداث المعتمدة

| الحدث | المصدر | المعالجة |
|-------|--------|---------|
| طلب جديد من الكاشير | Interceptor | `preparing`، بث للموظف والسحابة |
| "جاهز" من الموظف المحلي | Local WS | تطبيق Rank، بث، queue للسحابة |
| "جاهز" من الموظف عبر السحابة | Cloud WS | تطبيق Rank، بث محلياً |
| "تم التسليم" | Local أو Cloud WS | تطبيق Rank، بث، queue |
| "إلغاء" | Local أو Cloud WS | يفوز دائماً، بث |
| "تصفير" | Local أو Cloud WS | كل النشطة → cleared، بث |

---

## ٦. المكوّن: Local Storage

### ٦.١ ملفان منفصلان

```
<getDataDir()>/
  ├── active_orders.jsonl    ← الطلبات النشطة
  └── sync_queue.jsonl       ← بانتظار المزامنة
```

### ٦.٢ `active_orders.jsonl`

- Append-only للتعديلات
- آخر سطر بنفس `id` = الحالة الحالية
- تنظيف دوري كل ساعة (rewrite بدون الـ delivered/cancelled/cleared)

### ٦.٣ `sync_queue.jsonl`

```json
{
  "queue_id": "uuid",
  "order_id": "uuid-of-order",
  "status": "ready",
  "at": 1746345900000,
  "attempt_count": 0,
  "last_attempt": null
}
```

### ٦.٤ الاستعادة عند بدء التشغيل

(من `decisions_session_03.md` بند ٢.٧)

- قراءة `active_orders.jsonl` كاملاً
- تحميل في in-memory map
- لا منطق خاص (الموظف يستخدم "تصفير الشاشة" إذا لزم)
- بدء الاستقبال فوراً
- قراءة `sync_queue.jsonl` ومحاولة المزامنة

---

## ٧. المكوّن: Cloud Sync Client

### ٧.١ الإرسال (محلي → سحابة)

#### التدفق

```
تغيير حالة محلي
       ↓
كتابة في active_orders.jsonl + sync_queue.jsonl
       ↓
بث للموظف عبر WebSocket المحلي (فوري)
       ↓
محاولة الإرسال للسحابة (background)
       ↓
عند النجاح: تحديث synced + حذف من sync_queue
```

#### نقطة النهاية

```
POST {config.cloud.base_url}/api/orders/events
Authorization: Bearer {api_key}

{
  "events": [
    {
      "queue_id": "uuid",
      "order_id": "uuid",
      "order_number": 47,
      "status": "ready",
      "status_rank": 2,
      "extracted": true,
      "at": 1746345900000
    }
  ]
}
```

#### Batching

- كل 2 ثواني: إرسال كل ما في sync_queue
- الحد الأقصى: 50 حدث/دفعة
- عند النجاح: حذف من القائمة
- عند الفشل: ترك القائمة كما هي، إعادة بعد 2 ثواني

#### إعادة المحاولة

| السبب | السلوك |
|-------|--------|
| Network error | إعادة بعد 2 ثواني |
| HTTP 5xx | exponential backoff (max 60s) |
| HTTP 4xx | إعادة بعد 60 ثانية، error log |
| HTTP 401 | إيقاف، critical log |

### ٧.٢ الاستقبال (سحابة → محلي)

عبر WebSocket مفتوح طوال الوقت.

```
WebSocket إلى: {config.cloud.ws_url}/local-agent?restaurant_id={id}&api_key={key}
```

عند فقدان الاتصال: إعادة تلقائية بـ exponential backoff (1s, 2s, 4s, 8s, max 30s).

#### الرسائل المُستقبَلة

```json
{ "type": "order_event", "data": { "order_id": "...", "status": "...", ... } }
{ "type": "settings_updated" }
{ "type": "ping" }
```

عند `order_event`: تطبيق State Rank Wins، تحديث الذاكرة، الكتابة في JSONL، **بث على WebSocket المحلي للموظفين المتصلين محلياً**.

### ٧.٣ إبلاغ السحابة بـ LAN IP

**مهم لـ Promise.race:** السحابة تحتاج معرفة الـ LAN IP الخاص بالبرنامج المحلي لتخبر صفحة الموظف بأين تتصل محلياً.

```javascript
// كل 5 دقائق، أو عند تغيّر الـ IP
async function reportStatus() {
  const lanIps = platform.getLocalIpAddresses()
  
  ws.send(JSON.stringify({
    type: 'status',
    data: {
      lan_ips: lanIps,                  // مصفوفة (قد يكون أكثر من واحد)
      websocket_port: config.local_server.websocket_port,
      active_orders_count: orders.size,
      sync_queue_size: syncQueue.count(),
      printer_status: currentPrinterStatus,
      uptime_seconds: process.uptime()
    }
  }))
}
```

السحابة تحفظ هذه المعلومات وتعرضها لصفحة الموظف عند طلبها.

---

## ٨. المكوّن: Local WebSocket Server للموظف (جديد)

### ٨.١ الوظيفة

خادم WebSocket محلي يخدم اتصالات صفحة الموظف من نفس الشبكة المحلية، ليعمل النظام حتى عند انقطاع الإنترنت.

### ٨.٢ الإعداد

```javascript
const WebSocketServer = require('ws').Server

const wss = new WebSocketServer({
  port: config.local_server.websocket_port,  // 9200
  host: config.local_server.bind_address      // 0.0.0.0
})

wss.on('connection', handleConnection)
```

### ٨.٣ المصادقة عند الاتصال

```javascript
async function handleConnection(ws, request) {
  // استخراج PIN من query string
  const url = new URL(request.url, `http://${request.headers.host}`)
  const pin = url.searchParams.get('pin')
  
  // التحقق من PIN
  if (!pin || pin !== config.restaurant.staff_pin) {
    ws.send(JSON.stringify({ type: 'auth_failed' }))
    ws.close(4001, 'Invalid PIN')
    logger.warn('staff connection rejected: invalid PIN', { ip: request.socket.remoteAddress })
    return
  }
  
  // الاتصال مقبول
  logger.info('staff connected from', request.socket.remoteAddress)
  registerStaffClient(ws)
  
  // إرسال الحالة الحالية فوراً
  sendActiveOrders(ws)
  sendPrinterStatus(ws)
}
```

### ٨.٤ الـ Contract: نفس السحابة

**مبدأ مهم:** صفحة الموظف لا تحتاج معرفة إذا كانت متصلة محلياً أم سحابياً. الرسائل بنفس الشكل في الحالتين.

#### الرسائل من البرنامج المحلي → الموظف

**`order_event`:**
```json
{
  "type": "order_event",
  "data": {
    "order_id": "uuid",
    "order_number": 47,
    "status": "ready",
    "status_rank": 2,
    "at": 1746345900000,
    "source": "local"
  }
}
```

**`clear_screen`:**
```json
{ "type": "clear_screen", "at": 1746345900000 }
```

**`printer_status`:**
```json
{ "type": "printer_status", "data": { "status": "failed", "since": 1746345900000 } }
```

**`active_orders`:** (يُرسَل عند الاتصال)
```json
{
  "type": "active_orders",
  "data": {
    "orders": [
      { "id": "uuid", "order_number": 47, "status": "preparing", "since": 1746345600000 }
    ]
  }
}
```

**`ping`/`pong`:** heartbeat كل 30 ثانية

#### الرسائل من الموظف → البرنامج المحلي

**`change_state`:**
```json
{
  "type": "change_state",
  "data": {
    "order_id": "uuid",
    "status": "ready",
    "at": 1746345900000
  }
}
```

**`clear_screen`:**
```json
{ "type": "clear_screen", "at": 1746345900000 }
```

### ٨.٥ معالجة أوامر الموظف

```javascript
async function handleStaffCommand(ws, message) {
  const { type, data } = JSON.parse(message)
  
  switch (type) {
    case 'change_state': {
      const { order_id, status, at } = data
      const order = orders.get(order_id)
      
      if (!order) {
        ws.send(JSON.stringify({ type: 'error', error: 'order_not_found' }))
        return
      }
      
      // تطبيق State Rank Wins
      const newRank = STATE_RANKS[status]
      const result = applyStateChange(order, { status, rank: newRank, at, source: 'staff_local' })
      
      if (!result.applied) {
        ws.send(JSON.stringify({ type: 'state_change_ignored', data: { order_id } }))
        return
      }
      
      // كتابة في JSONL
      await ordersStore.append(result.newRecord)
      
      // إضافة لـ sync queue (للسحابة)
      await syncQueue.append({
        queue_id: uuidv4(),
        order_id,
        status,
        at,
        source: 'staff_local'
      })
      
      // بث لكل الموظفين المتصلين محلياً
      broadcastToStaff({
        type: 'order_event',
        data: { order_id, order_number: order.order_number, status, status_rank: newRank, at, source: 'staff_local' }
      })
      
      // الـ Sync Client سيرسل للسحابة في الـ batch القادم
      break
    }
    
    case 'clear_screen': {
      // كل النشطة → cleared
      for (const order of orders.values()) {
        if (order.status === 'preparing' || order.status === 'ready') {
          await applyClearedToOrder(order.id, data.at)
        }
      }
      
      broadcastToStaff({ type: 'clear_screen', at: data.at })
      
      await syncQueue.append({
        queue_id: uuidv4(),
        type: 'clear_screen',
        at: data.at,
        source: 'staff_local'
      })
      break
    }
    
    case 'pong':
      // heartbeat
      break
    
    default:
      logger.warn('unknown staff command', { type })
  }
}
```

### ٨.٦ التزامن بين المصادر

**السيناريو الحرج:** موظف يضغط "جاهز" محلياً، وفي نفس اللحظة موظف آخر يضغط "تم التسليم" عبر السحابة.

**الحل:** State Rank Wins يحل التضارب طبيعياً. كلا التغييرين يصلان للبرنامج المحلي (واحد من WebSocket المحلي، والثاني من Cloud WS Client). آخر تغيير له rank أعلى يفوز.

**ملاحظة:** عند تطبيق تغيير محلي، الـ Sync Client يبعته للسحابة. السحابة تطبّقه وتبثه للأطراف الأخرى (شاشة، موظفون آخرون). لو الـ Cloud WS Client يستقبل نفس التغيير عائداً، State Rank Wins يضمن أن النتيجة لا تتغيّر (نفس الـ rank).

### ٨.٧ بث عند تغيّر `staff_pin`

عندما يستقبل البرنامج إشعار `settings_updated` ويتغيّر `staff_pin`:

```javascript
async function onPinChanged(oldPin, newPin) {
  // قطع كل الاتصالات الحالية
  wss.clients.forEach(client => {
    client.send(JSON.stringify({ type: 'pin_changed' }))
    client.close(4002, 'PIN changed')
  })
  
  logger.info('staff_pin changed, all local connections terminated')
}
```

صفحة الموظف ستحاول إعادة الاتصال بالـ PIN القديم → ستُرفَض → ستحذف PIN من localStorage → ستطلب من الموظف إدخال PIN الجديد.

### ٨.٨ معالجة الانفصال

```javascript
ws.on('close', () => {
  unregisterStaffClient(ws)
  logger.info('staff disconnected')
})

ws.on('error', (err) => {
  logger.warn('staff connection error', { error: err.message })
})
```

### ٨.٩ Heartbeat

كل 30 ثانية، البرنامج يبعث `ping` لكل العملاء. عملاء لا يردّون بـ `pong` خلال 60 ثانية = يُقطَع اتصالهم.

---

## ٩. التزامن مع PRDs أخرى

### ٩.١ ما يحتاجه هذا الـ PRD من PRD #1

- `JsonlStore`
- `PlatformAdapter.setupPrintInterception()`
- `PlatformAdapter.getLocalIpAddresses()` ← مهم لإبلاغ السحابة
- `logger`
- `config` (شامل `staff_pin`، `local_server.*`)

### ٩.٢ ما يحتاجه PRD #3 من هذا الـ PRD

- شكل الـ event المُرسَل: `{ queue_id, order_id, order_number, status, status_rank, extracted, at }`
- شكل الـ status message: `{ lan_ips, websocket_port, active_orders_count, ... }`
- شكل رسائل WebSocket من السحابة

### ٩.٣ ما يحتاجه PRD #5 من هذا الـ PRD

- WebSocket على `ws://{lan_ip}:{websocket_port}?pin={pin}` (نفس الـ contract كالسحابة)
- نفس شكل الرسائل (`order_event`, `clear_screen`, `printer_status`, `change_state`, إلخ)

---

## ١٠. اختبارات مطلوبة

### ١٠.١ Unit Tests

- `extractor.js`: 20+ حالة (عربي، إنجليزي، ترميزات، edge cases)
- `rank.js`: كل تركيبات state transitions
- `JsonlStore`: append, readAll, rewrite, errors
- `decoder.js`: UTF-8، Windows-1256، CP864
- `staff-ws-server`: مصادقة، معالجة الأوامر، broadcasting

### ١٠.٢ Integration Tests

- Fake Cashier → Interceptor → Fake Printer → JSONL → بث
- 100 طلب متتالي → كل وصل لكل المكونات
- الطابعة مفصولة → 3 محاولات → بث `printer_status: failed`
- السحابة مفصولة → الطلبات تُكدَّس → عند العودة تُرسَل
- إيقاف وإعادة → الطلبات النشطة تُستعاد
- **اختبار Promise.race:** فتح اتصالين (محلي + سحابي) من نفس العميل → كلاهما يستقبل الأحداث متزامنين
- **تغيير PIN:** الموظف متصل محلياً → تغيير PIN في السحابة → الموظف يُطرَد
- **تضارب محلي/سحابي:** ضغط "جاهز" محلياً وضغط "تم التسليم" سحابياً في نفس اللحظة → State Rank Wins يحل

### ١٠.٣ اختبار الأداء

- متوسط زمن التمرير للطابعة: < 10ms
- زمن المعالجة الكاملة لطلب: < 50ms
- 50 موظف WebSocket متصل في نفس الوقت: استقرار

---

## ١١. معايير القبول

- [ ] TCP server يستمع ويقبل من cashier_ip فقط
- [ ] التمرير للطابعة < 10ms
- [ ] 3 محاولات × 200ms تعمل
- [ ] استخراج الرقم يعمل مع 5+ صيغ مختلفة
- [ ] الرقم التسلسلي الاحتياطي يعمل
- [ ] State Rank Wins يطبَّق صحيحاً
- [ ] `cleared` تطبَّق على كل النشطة
- [ ] `active_orders.jsonl` و `sync_queue.jsonl` يعملان
- [ ] إعادة التشغيل تستعيد الطلبات النشطة
- [ ] التنظيف الدوري يعمل
- [ ] Sync Client يرسل في batches
- [ ] قائمة المزامنة تتنظف عند التأكيد
- [ ] WebSocket مع السحابة يعيد الاتصال
- [ ] Settings Listener يحدّث `config.json`
- [ ] **خادم WebSocket المحلي للموظف يعمل**
- [ ] **المصادقة بـ PIN على الاتصال المحلي**
- [ ] **PIN خاطئ يُغلَق الاتصال**
- [ ] **بث الأحداث للموظفين المتصلين محلياً**
- [ ] **استقبال أوامر الموظف ومعالجتها**
- [ ] **تغيير PIN يطرد كل الاتصالات الحالية**
- [ ] **إبلاغ السحابة بـ LAN IPs دورياً**
- [ ] لا crash عند أي فشل خارجي

---

## ١٢. الجدول الزمني المتوقع

| اليوم | المهمة |
|------|--------|
| 1 | TCP Server (Interceptor) + اختبار التمرير |
| 2 | آلية إعادة المحاولة + اختبارات الفشل |
| 3 | Order Extractor + المكتبة + الترميزات العربية |
| 4 | Order State Manager + State Rank Wins |
| 5 | Storage (active_orders + sync_queue) + التنظيف |
| 6 | Cloud Sync Client (الإرسال + batching) |
| 7 | Cloud Sync Client (الاستقبال + إبلاغ LAN IP) |
| 8 | **Local WebSocket Server (إعداد + auth + handlers)** |
| 9 | **Local WebSocket Server (broadcasting + اختبارات)** |
| 10 | Settings Listener + Printer Status |
| 11 | اختبارات تكامل شاملة |
| 12 | اختبار Promise.race + Edge cases |
| 13 | اختبارات أداء + توثيق |

**الإجمالي: 13 يوم عمل تقريبية.**

---

## ١٣. مخاطر تقنية موثقة

### ١٣.١ ترميز النص العربي

**التخفيف:** 3 ترميزات + رقم تسلسلي احتياطي + اختبار في الزيارة الاستكشافية للمطعم.

### ١٣.٢ تأخير غير متوقع في التمرير

**التخفيف:** streaming، قياس دقيق، logs.

### ١٣.٣ تضارب الحالة بين المحلي والسحابي

**التخفيف:** State Rank Wins يحل تلقائياً. اختبارات مكثفة لسيناريوهات السباق.

### ١٣.٤ Firewall يحجب البورت 9200

**التخفيف:** سكريبت `install.bat` (PRD #7) يفتح البورت تلقائياً.

### ١٣.٥ موظف على شبكة مختلفة عن المطعم

**السيناريو:** موظف على بيانات خلوية (4G) → ما يقدر يصل للـ LAN IP محلياً.

**التخفيف:** Promise.race يحلها طبيعياً — السحابي يفوز. الموظف لا يلاحظ شيئاً.

---

**نهاية PRD #2 (النسخة 1.1).**
