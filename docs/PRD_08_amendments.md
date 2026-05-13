# PRD #8: التعديلات والتوضيحات (Amendments & Clarifications)

> **الغرض من هذا المستند:** توثيق كل التعديلات والإضافات والتوضيحات التي ظهرت أثناء تطوير PRDs #1-#7. بدلاً من إعادة كتابة كل PRD، تُجمَع التغييرات هنا في مرجع موحَّد.

> **الأولوية:** عند تضارب هذا المستند مع PRDs السابقة، **هذا المستند يأخذ الأولوية**.

> **آخر تحديث:** الإصدار 1.0

---

## ١. ملخص تنفيذي للتعديلات

التطوير المتسلسل لـ PRDs #1-#7 كشف ٤ أنواع من القضايا:

١. **قرارات معمارية معلّقة** (تحتاج حسم)
٢. **عقود (contracts) ناقصة** بين المكوّنات (endpoints مفقودة، حقول غير محددة)
٣. **تضاربات** بين PRDs (مثل JWT vs PIN-direct)
٤. **توضيحات** لأنماط متكررة (event_id، State Rank Wins، شكل الرسائل)

هذا المستند يحسم الجميع.

---

## ٢. القرارات المعمارية المعلّقة

### ٢.١ مشكلة Mixed Content في صفحة الموظف

**السياق:**
صفحة الموظف تحتاج اتصال محلي (`ws://192.168.x.x:9200`) واتصال سحابي (`wss://api.queue-manager.com`) بـ Promise.race. لكن المتصفحات الحديثة **تمنع** صفحة HTTPS من فتح اتصال WebSocket غير مشفّر (`ws://`).

**الخيارات:**

#### الخيار أ: نسختان من الصفحة (موصى به ✓)

- الـ Local Agent يخدم نسخة من صفحة الموظف على HTTP محلياً
- السحابة تخدم نسخة على HTTPS عبر الإنترنت

**الاستخدام:**
- الموظف داخل المطعم على واي فاي → `http://192.168.1.88:9200/staff` (نسخة كاملة بـ Promise.race)
- الموظف خارج المطعم على الخلوي → `https://staff.app.com/{restaurant_id}` (نسخة سحابية فقط)

**الإيجابيات:**
- يحقق وعد "النظام يعمل بدون إنترنت"
- لا تنازل عن المعمارية الأصلية في session 02
- لا حاجة لشهادات SSL محلية

**السلبيات:**
- نوزّع رابطين للموظف
- الـ Local Agent يحتاج HTTP server إضافي

#### الخيار ب: الإلغاء التام للاتصال المحلي من الصفحة السحابية

- صفحة الموظف السحابية فقط، بدون Promise.race
- الفائدة المعمارية تُلغى
- لو الإنترنت قطع، الموظف لا يستطيع التحديث

**الإيجابيات:** أبسط بكثير

**السلبيات:** يخالف فلسفة `decisions_session_02.md` بند ٥

#### الخيار ج: شهادة self-signed على الـ Local Agent

- الـ Local Agent يولّد شهادة محلية
- الموبايل يحتاج قبولها (تحذير أمني مرعب)

**الإيجابيات:** نسخة واحدة من الصفحة

**السلبيات:** تجربة مستخدم سيئة جداً، رفض من بعض المتصفحات

### ٢.١.١ القرار

**نعتمد الخيار أ (نسختان من الصفحة).**

**التداعيات على PRDs:**
- PRD #1: إضافة HTTP server config إلى PlatformAdapter
- PRD #2: إضافة HTTP server محلي + WebSocket /staff
- PRD #5: توضيح طريقة التوزيع (رابطان)
- PRD #7: فتح بورت 9200 في Firewall (موجود بالفعل)

**ملاحظة:** هذا القرار قابل للمراجعة. لو أردت العودة للخيار ب لتسريع الإطلاق، أعلمني وسنوثّق التغيير.

---

## ٣. تعديلات على PRD #1 (البنية والإعدادات)

### ٣.١ توسعة `config.json`

**المضاف:** `staff_pin` كحقل صريح في الـ schema الجذري.

```json
{
  "version": 1,
  "restaurant": { ... },
  "cloud": { ... },
  "network": { ... },
  "extractor": { ... },
  "service": { ... },
  "logging": { ... },
  "local_server": {
    "http_port": 9200,
    "websocket_port": 9200,
    "bind_address": "0.0.0.0"
  },
  "staff_pin": "483921"
}
```

**ملاحظة:** الـ HTTP server والـ WebSocket server يستخدمان **نفس البورت (9200)** عبر آلية HTTP Upgrade القياسية. هذا يبسّط Firewall (بورت واحد).

### ٣.٢ توسعة PlatformAdapter

**المضافة:**

```javascript
class PlatformAdapter {
  // (الموجودة سابقاً)
  getDataDir()
  installAsService()
  setupPrintInterception()
  logSystemEvent()
  
  // المضافة:
  
  /**
   * يكتشف عناوين IP المحلية للجهاز (LAN IPs)
   * يُستخدَم لإبلاغ السحابة + خدمة الموظفين على الشبكة المحلية
   * @returns {Array<string>} مثل ["192.168.1.88"]
   */
  getLocalIpAddresses()
  
  /**
   * يضمن بقاء الـ IP alias بعد إعادة التشغيل
   * يُستدعى عند بدء الخدمة
   */
  ensureIpAliasPersistent(originalIp, interfaceName)
}
```

### ٣.٣ توسعة بنية المجلدات

**المضاف:** مجلد `src/server/` لخدمات HTTP + WebSocket المحلية.

```
src/
├── core/
│   ├── interceptor/
│   ├── extractor/
│   ├── state-manager/
│   └── sync-queue/
├── server/                    ← جديد
│   ├── http-server.js         ← يخدم صفحة الموظف
│   ├── ws-server.js           ← WebSocket للموظفين
│   └── static/                ← ملفات صفحة الموظف
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── platform/
├── storage/
├── config/
└── ...
```

---

## ٤. تعديلات على PRD #2 (البرنامج المحلي)

### ٤.١ إضافة HTTP Server محلي

**الغرض:** خدمة صفحة الموظف عبر HTTP محلياً (لحل Mixed Content).

**المتطلبات:**
- يخدم على البورت 9200
- يُرجِع `index.html` و الـ assets الستاتيكية
- يخدم endpoints محدودة جداً (لتجنّب التعقيد)

**المسارات:**

```
GET  /staff                    → index.html
GET  /staff/styles.css         → CSS
GET  /staff/app.js             → JavaScript
GET  /api/local/health         → { status: "ok", uptime: 3600 }
```

**ملاحظة:** الصفحة المحلية تتصل بنفس الـ Local Agent عبر WebSocket محلي (انظر القسم ٤.٢) وعبر السحابة كـ احتياط (Promise.race).

### ٤.٢ إضافة WebSocket Server للموظفين

**المسار:** `ws://{host}:9200/staff`

**المصادقة:**

```
ws://192.168.1.88:9200/staff?pin=483921
```

السيرفر يتحقق من `pin` ضد `config.staff_pin`. إذا لم يطابق، يرفض الاتصال (close code 4401).

### ٤.٣ معالجة `order_command` من الموظف

**الرسائل من الموظف → Local Agent:**

```json
{
  "type": "order_command",
  "data": {
    "order_id": "uuid",
    "status": "ready",
    "at": 1746345900000,
    "pin": "483921"
  }
}
```

**معالجتها:**

```javascript
function handleStaffCommand(message) {
  // 1. التحقق من PIN مرة أخرى
  if (message.data.pin !== config.staff_pin) {
    return  // تجاهل
  }
  
  // 2. تحويل لـ event مع event_id
  const event = {
    event_id: generateUuid(),
    order_id: message.data.order_id,
    status: message.data.status,
    status_rank: STATE_RANKS[message.data.status],
    at: message.data.at,
    source: 'staff'
  }
  
  // 3. تطبيق State Rank Wins
  stateManager.applyEvent(event)
  
  // 4. البث لكل المستهلكين المحليين (موظفون آخرون)
  wsServer.broadcastToStaff(event)
  
  // 5. الإرسال للسحابة (sync queue)
  syncQueue.enqueue(event)
}
```

### ٤.٤ إرسال `lan_ip` للسحابة

**في رسالة status الدورية:**

```json
{
  "type": "status",
  "data": {
    "lan_ips": ["192.168.1.88"],
    "local_ws_port": 9200,
    "local_http_port": 9200,
    "active_orders_count": 12,
    "sync_queue_size": 0,
    "printer_status": "ok",
    "uptime_seconds": 3600,
    "version": "1.0.0"
  }
}
```

**التوقيت:** كل 30 ثانية + عند بدء التشغيل + عند تغيير `lan_ip`.

### ٤.٥ بث الأحداث للموظفين المحليين

عند **أي** تغيير حالة (سواء من الكاشير، الموظف، أو السحابة):

```javascript
function onStateChange(event) {
  // 1. الحفظ المحلي
  storage.saveEvent(event)
  
  // 2. البث للموظفين المتصلين محلياً
  wsServer.broadcastToStaff({
    type: 'order_event',
    event_id: event.event_id,
    data: event
  })
  
  // 3. الإضافة لـ sync queue للسحابة
  syncQueue.enqueue(event)
}
```

### ٤.٦ استقبال أحداث من السحابة وبثها محلياً

عند وصول `order_event` من السحابة (مثلاً، موظف على الخلوي ضغط زر):

```javascript
cloudWs.on('order_event', (event) => {
  // 1. تطبيق State Rank Wins (قد يتجاهل لو الحدث المحلي أحدث)
  const applied = stateManager.applyEvent(event)
  
  // 2. لو طُبِّق: البث للموظفين المحليين
  if (applied) {
    wsServer.broadcastToStaff({
      type: 'order_event',
      event_id: event.event_id,
      data: event
    })
  }
})
```

### ٤.٧ ملخص بنية مكوّنات PRD #2 المحدّثة

```
Local Agent
├── TCP Server (port 9100)        ← اعتراض الطباعة
├── TCP Forwarder                  ← إعادة الإرسال للطابعة
├── Order Extractor               
├── State Manager                 
├── JSONL Storage                 
├── Sync Queue                    
├── Cloud WebSocket Client         ← اتصال بالسحابة
├── HTTP Server (port 9200)        ← جديد: خدمة صفحة الموظف
├── WebSocket Server (port 9200)   ← جديد: قناة للموظفين المحليين
└── Health Checker
```

---

## ٥. تعديلات على PRD #3 (السحابة)

### ٥.١ المصادقة: PIN مباشر بدل JWT

**التعديل في `/api/staff/login`:**

```
POST /api/staff/login
```

**Request:**
```json
{ "restaurant_id": "rest_a8f3k2", "pin": "483921" }
```

**Response (200):**
```json
{ "valid": true, "restaurant_name": "مطعم الشرق" }
```

**Response (401):**
```json
{ "valid": false, "error": "invalid_credentials" }
```

**ملاحظات:**
- لا session_token، لا JWT
- الصفحة تحفظ PIN في localStorage بعد النجاح
- كل request لاحق يحتوي على header `X-Staff-Pin`

### ٥.٢ Headers موحّدة لـ Staff

**كل endpoint للموظف يطلب:**

```
X-Restaurant-Id: rest_a8f3k2
X-Staff-Pin: 483921
```

**Middleware موحّد:**

```javascript
async function authenticateStaff(request, reply) {
  const restaurantId = request.headers['x-restaurant-id']
  const pin = request.headers['x-staff-pin']
  
  if (!restaurantId || !pin) {
    return reply.code(401).send({ error: 'missing_credentials' })
  }
  
  const restaurant = await db.restaurants.findById(restaurantId)
  if (!restaurant?.is_active || restaurant.staff_pin !== pin) {
    return reply.code(401).send({ error: 'invalid_credentials' })
  }
  
  request.restaurant = restaurant
}
```

### ٥.٣ Endpoint جديد: GET /api/staff/active-orders

```
GET /api/staff/active-orders
Headers: X-Restaurant-Id, X-Staff-Pin
```

**Response:**
```json
{
  "orders": [
    {
      "id": "uuid",
      "order_number": 47,
      "status": "preparing",
      "status_rank": 1,
      "since": 1746345600000,
      "last_updated": 1746345600000
    }
  ]
}
```

يُرجِع كل الطلبات في حالات `preparing` أو `ready` للمطعم.

### ٥.٤ Endpoint جديد: GET /api/staff/connection-info

```
GET /api/staff/connection-info
Headers: X-Restaurant-Id, X-Staff-Pin
```

**Response:**
```json
{
  "cloud_ws": "wss://api.queue-manager.com/ws/staff",
  "local_ws": "ws://192.168.1.88:9200/staff",
  "lan_ip_last_seen": 1746345600000,
  "agent_status": "connected"
}
```

**المنطق:**
- `cloud_ws`: ثابت، يأتي من config السيرفر
- `local_ws`: يُبنى من آخر `lan_ip` معروف للمطعم + البورت 9200
- `lan_ip_last_seen`: متى آخر مرة وصلت رسالة status من البرنامج المحلي
- لو `lan_ip_last_seen > 5 دقائق`: تُرجَع `local_ws: null`

### ٥.٥ توسعة جدول `restaurants`

```sql
ALTER TABLE restaurants ADD COLUMN lan_ips JSONB;
ALTER TABLE restaurants ADD COLUMN ws_port INTEGER;
ALTER TABLE restaurants ADD COLUMN last_seen_at TIMESTAMPTZ;
ALTER TABLE restaurants ADD COLUMN agent_status VARCHAR(20);
```

`agent_status`: `connected` | `disconnected` | `unknown`

### ٥.٦ معالجة رسائل status من البرنامج المحلي

عند استلام WebSocket message:

```json
{ "type": "status", "data": { "lan_ips": [...], ... } }
```

**التحديث:**

```javascript
async function handleAgentStatus(restaurantId, statusData) {
  await db.restaurants.update(restaurantId, {
    lan_ips: statusData.lan_ips,
    ws_port: statusData.local_ws_port,
    last_seen_at: new Date(),
    agent_status: 'connected'
  })
}
```

**عند انقطاع WebSocket:**

```javascript
ws.on('close', async () => {
  await db.restaurants.update(restaurantId, {
    agent_status: 'disconnected'
  })
})
```

### ٥.٧ event_id في كل event

**كل حدث يُبَث على WebSocket لازم يحتوي `event_id` فريد.**

**التوليد:**
- Local Agent يُولِّد UUID v4 لكل حدث ينشئه
- السحابة تُولِّد UUID v4 لأحداثها (أوامر الموظف عبر REST، إلخ)
- الـ event_id يُحفَظ في `event_log` لمنع المعالجة المكررة

**شكل event موحّد:**

```json
{
  "type": "order_event",
  "event_id": "uuid-v4",
  "data": {
    "order_id": "uuid",
    "order_number": 47,
    "status": "ready",
    "status_rank": 2,
    "at": 1746345900000,
    "source": "local|staff|admin"
  }
}
```

### ٥.٨ Idempotency في POST /api/orders/events

**التحديث:**

```javascript
async function applyEvent(event) {
  // 1. التحقق من event_id (لمنع التكرار)
  const existing = await db.eventLog.findByEventId(event.event_id)
  if (existing) {
    return { applied: false, reason: 'duplicate' }
  }
  
  // 2. State Rank Wins
  // ... (كما هو)
  
  // 3. حفظ في event_log مع event_id
  await db.eventLog.create({
    event_id: event.event_id,
    restaurant_id: ...,
    ...
  })
}
```

**على جدول `event_log`:**

```sql
ALTER TABLE event_log ADD COLUMN event_id VARCHAR(40) UNIQUE;
CREATE INDEX idx_event_log_event_id ON event_log(event_id);
```

---

## ٦. تعديلات على PRD #4 (الشاشة)

**لا تعديلات وظيفية.** التعديلات الوحيدة:

### ٦.١ event_id في الأحداث المُستقبَلة

عند استقبال `order_event`، استخدام `event_id` للـ deduplication (نفس آلية صفحة الموظف).

```javascript
const seenEvents = new Set()

function handleEvent(event) {
  if (seenEvents.has(event.event_id)) return
  seenEvents.add(event.event_id)
  applyOrderEvent(event.data)
}
```

(الشاشة لا تحتاج deduplication فعلياً لأنها متصلة بقناة واحدة فقط، لكن نضيفها كحماية إضافية للسلامة.)

---

## ٧. تعديلات على PRD #5 (صفحة الموظف)

### ٧.١ توضيح Mixed Content

بناءً على القرار في القسم ٢.١ (الخيار أ):

**الصفحة لها نسختان:**

| النسخة | المسار | الميزات | متى تُستخدَم |
|--------|--------|---------|---------------|
| محلية | `http://{lan_ip}:9200/staff` | Promise.race كامل (محلي + سحابي) | الموظف على واي فاي المطعم |
| سحابية | `https://staff.app.com/{restaurant_id}` | سحابي فقط | الموظف على الخلوي |

**ملاحظة:** الكود مشترك تقريباً 100%. الفرق فقط في:
- النسخة المحلية: تحاول `ws://localhost:9200/staff` و `wss://api.queue-manager.com/ws/staff` بـ Promise.race
- النسخة السحابية: تحاول `wss://api.queue-manager.com/ws/staff` فقط

التمييز يحدث عبر متغيّر JavaScript (`__ENV__`) يُحقن من الـ HTTP server المحلي وليس عند السحابي.

### ٧.٢ event_id موحّد

كما في القسم ٥.٧، الموظف يحفظ آخر 100 event_id لمنع التكرار.

### ٧.٣ Header الإرسال

كل request للسحابة يُرسَل بـ:

```
X-Restaurant-Id: rest_a8f3k2
X-Staff-Pin: {pin من localStorage}
```

(بدون JWT، بدون session_token)

---

## ٨. تعديلات على PRD #6 (لوحة التحكم)

### ٨.١ تأكيد PIN-direct

اللوحة تتعامل مع PIN كنص عادي يُحفَظ في `restaurants.staff_pin`. **لا hashing**. (مذكور في PRD #3 قسم ٤.٤، نُؤكِّد هنا.)

### ٨.٢ تعريف `agent_status`

في صفحة المطعم:

```javascript
function deriveAgentStatus(restaurant) {
  const minutesSinceLastSeen = (Date.now() - restaurant.last_seen_at) / 60000
  
  if (minutesSinceLastSeen < 1) return 'online'      // 🟢
  if (minutesSinceLastSeen < 5) return 'idle'        // 🟡
  return 'offline'                                    // 🔴
}
```

### ٨.٣ زر "إعادة تحميل الإعدادات"

في صفحة تفاصيل المطعم:

**`POST /admin/api/restaurants/{id}/push-settings-update`**

**المنطق:**
- تبث `settings_updated` للبرنامج المحلي
- البرنامج يجلب الإعدادات الجديدة من `/api/restaurants/{id}/config`

---

## ٩. تعديلات على PRD #7 (التثبيت)

### ٩.١ Firewall — تأكيد البورت 9200

البورت 9200 يخدم **HTTP و WebSocket معاً** (عبر HTTP Upgrade). فتح بورت واحد يكفي.

```batch
netsh advfirewall firewall add rule ^
    name="Queue Manager - Local Server" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=9200 ^
    profile=private
```

(بدلاً من قاعدتين منفصلتين كما كانت موصوفة سابقاً.)

### ٩.٢ Test Mode على البورت 9300

البورت 9300 (لـ Test Mode فقط) لا يحتاج فتح Firewall في التشغيل العادي. الفنّي يفتحه يدوياً عند الاختبار:

```batch
netsh advfirewall firewall add rule ^
    name="Queue Manager - Test Mode (Temporary)" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=9300 ^
    profile=private
```

ويحذفه بعد الاختبار:

```batch
netsh advfirewall firewall delete rule name="Queue Manager - Test Mode (Temporary)"
```

### ٩.٣ توضيح URL المحلي للموظف

في دليل التركيب (PRD #7 قسم ٩، المرحلة ٧):

```
- على موبايل الموظف داخل المطعم:
  افتح: http://{lan_ip}:9200/staff
  مثلاً: http://192.168.1.88:9200/staff

- على موبايل الموظف خارج المطعم (للضرورة):
  افتح: https://staff.app.com/{restaurant_id}
```

**النصيحة للفنّي:** أنشئ QR code يحتوي الرابط المحلي → الموظف يمسحه مرة واحدة → يُضاف كـ shortcut.

---

## ١٠. توضيحات عبر النظام

### ١٠.١ State Rank Wins — التطبيق الموحّد

**القاعدة (تُطبَّق في 3 أماكن):**

١. Local Agent (`src/core/state-manager/`)
٢. السحابة (في `applyOrderEvent`)
٣. الواجهات (الشاشة، الموظف) — للسلامة

**الكود الموحَّد:**

```javascript
const STATE_RANKS = {
  'preparing': 1,
  'ready': 2,
  'delivered': 3,
  'cancelled': 99,
  'cleared': 99
}

function stateRankWins(currentEvent, newEvent) {
  // الحالات النهائية (rank 99) تفوز دائماً
  if (newEvent.status_rank === 99) return newEvent
  if (currentEvent.status_rank === 99) return currentEvent
  
  // غير ذلك: الـ rank الأعلى يفوز
  return newEvent.status_rank > currentEvent.status_rank ? newEvent : currentEvent
}
```

### ١٠.٢ شكل الرسائل الموحَّد عبر WebSocket

**كل الرسائل** بين أي مكوّنين (Local Agent ↔ Cloud, Cloud ↔ Display, Cloud ↔ Staff, Local Agent ↔ Local Staff):

```typescript
type Message = {
  type: string
  event_id?: string  // مطلوب لـ events، اختياري لـ ping/status
  data?: any
  timestamp?: number
}
```

**الأنواع المعرَّفة:**

| نوع | الاتجاه | البيانات |
|-----|---------|----------|
| `order_event` | كل الاتجاهات | order data |
| `clear_screen` | السحابة → الشاشات والموظفين | فارغ |
| `printer_status` | Local → Cloud → Staff | { status, since } |
| `settings_updated` | Cloud → Local | فارغ |
| `status` | Local → Cloud | حالة البرنامج |
| `order_command` | Staff → Local | { order_id, status, pin } |
| `ping` / `pong` | كل الاتجاهات | فارغ |

### ١٠.٣ المصادقة عبر النظام

| المُصدِق | المُستهلِك | المفتاح | الموقع |
|---------|-----------|---------|---------|
| Local Agent | Cloud | `api_key` | `Authorization: Bearer ...` |
| Staff Phone | Cloud (REST) | `pin` | `X-Restaurant-Id`, `X-Staff-Pin` |
| Staff Phone | Cloud (WS) | `pin` | URL: `?restaurant_id=X&pin=Y` |
| Staff Phone | Local Agent (WS) | `pin` | URL: `?pin=Y` |
| Display | Cloud (WS) | لا شيء | URL: `/ws/display/{id}` |
| Admin | Cloud (LOL Admin) | `username`+`password` → JWT | `Authorization: Bearer ...` |

### ١٠.٤ شكل event موحَّد

كل order event، بغض النظر عن المصدر:

```json
{
  "event_id": "uuid-v4",
  "order_id": "uuid",
  "order_number": 47,
  "extracted": true,
  "status": "preparing|ready|delivered|cancelled|cleared",
  "status_rank": 1,
  "at": 1746345900000,
  "source": "local|staff|admin|cloud"
}
```

`source` يساعد في التشخيص (من فعل ماذا) لكن لا يؤثر على المنطق.

### ١٠.٥ Heartbeat Strategy

| القناة | الفترة | التطبيق |
|--------|--------|---------|
| Local Agent ↔ Cloud | 30 ثانية | السحابة ترسل ping، البرنامج يرد بـ pong |
| Display ↔ Cloud | 30 ثانية | السحابة ترسل ping |
| Staff ↔ Cloud | 30 ثانية | السحابة ترسل ping |
| Staff ↔ Local Agent | 30 ثانية | البرنامج يرسل ping |

**المهلة قبل اعتبار الاتصال مفقوداً:** 60 ثانية (ping ضائعَين).

---

## ١١. مصفوفة التغييرات الإجمالية

| PRD | حجم التغيير | الأقسام المتأثرة |
|-----|-------------|-------------------|
| #1 | متوسط | بنية المجلدات، PlatformAdapter، config.json |
| #2 | كبير | إضافة HTTP + WS server، order_command، lan_ip reporting |
| #3 | كبير | endpoints جديدة، مصادقة PIN-direct، event_id، توسعة DB |
| #4 | صغير | event_id deduplication فقط |
| #5 | متوسط | توضيح Mixed Content، headers موحّدة |
| #6 | صغير | تأكيدات PIN-direct، agent_status |
| #7 | صغير | بورت موحّد، URL محلي للموظف |

---

## ١٢. تأثير على الجدول الزمني الكلي

### ١٢.١ الجدول السابق

| PRD | الأيام السابقة |
|-----|----------------|
| #1 | 6 |
| #2 | 13 |
| #3 | 14 |
| #4 | 7 |
| #5 | 12 |
| #6 | 10 |
| #7 | 10 |
| **الإجمالي** | **72** |

### ١٢.٢ الجدول المُحدَّث

| PRD | الأيام المحدَّثة | السبب |
|-----|------------------|--------|
| #1 | 6 | لا تغيير زمني |
| #2 | 16 | +3 لـ HTTP/WS server |
| #3 | 14 | تغييرات داخل النطاق |
| #4 | 7 | لا تغيير |
| #5 | 12 | لا تغيير (التعديل توضيحي) |
| #6 | 10 | لا تغيير |
| #7 | 10 | لا تغيير |
| **الإجمالي** | **75** | +3 أيام |

### ١٢.٣ التوصية للنسخة الأولى (مطعم تجريبي)

تذكير من PRD #6 قسم ١٦.٣ ومن ملاحظاتنا السابقة:

**يمكن تأجيل PRD #6 (لوحة التحكم) للنسخة الثانية**، وإدارة المطعم الأول يدوياً عبر SQL/scripts.

**التوفير:** 10 أيام عمل.

**الجدول المُختصَر للمطعم الأول:** 65 يوم عمل بدلاً من 75.

---

## ١٣. ترتيب التطوير الموصى به

بناءً على التبعيات بعد التعديلات:

```
المرحلة 1 (الأساس):
   PRD #1 (Foundation)         ─── 6 أيام
   ↓
المرحلة 2 (السحابة + المحلي بالتوازي):
   PRD #3 (Cloud Backend)      ─── 14 يوم  ┐
   PRD #2 (Local Agent)        ─── 16 يوم  ┘  بالتوازي
   ↓
المرحلة 3 (الواجهات بالتوازي):
   PRD #4 (Display)            ─── 7 أيام  ┐
   PRD #5 (Staff Page)         ─── 12 يوم  ┘  بالتوازي
   ↓
المرحلة 4 (الإطلاق):
   PRD #7 (Installation)       ─── 10 أيام
   ↓
المرحلة 5 (التطوير المتأخر):
   PRD #6 (Admin Panel)        ─── 10 أيام  ← بعد المطعم الأول
```

**الزمن الكلي مع التوازي (مطوّر منفرد، لا parallelism حقيقي):** 65 يوم للمطعم الأول.

---

## ١٤. سجل التغييرات (Changelog)

### الإصدار 1.0 (تاريخ الكتابة الأول)

- ✓ حسم Mixed Content (الخيار أ: نسختان من الصفحة)
- ✓ إزالة JWT من staff endpoints (PIN-direct)
- ✓ إضافة `GET /api/staff/active-orders`
- ✓ إضافة `GET /api/staff/connection-info`
- ✓ توسعة جدول `restaurants` بحقول الـ agent
- ✓ إضافة HTTP + WebSocket server للموظفين في Local Agent
- ✓ إضافة `event_id` لكل event عبر النظام
- ✓ توحيد شكل الرسائل والمصادقة
- ✓ توحيد State Rank Wins في 3 أماكن
- ✓ تعريف `agent_status` بناءً على `last_seen_at`

---

## ١٥. ملاحظات نهائية

### ١٥.١ هذا المستند حي

أثناء التطوير، ستُكتشَف تفاصيل لم نتوقعها. **حدّث هذا المستند** بدلاً من الـ PRDs الأصلية.

### ١٥.٢ في حالة التضارب

**الترتيب التراتبي:**
1. هذا المستند (PRD #8)
2. PRDs #1-#7 الأصلية
3. `decisions_session_*.md`
4. `queue_management_system.md`
5. `ملخص_الفكرة`

عند التضارب، الأعلى يفوز.

### ١٥.٣ الخطوات التالية

١. **مراجعتك لهذا المستند** والتأكد من موافقتك على القرارات
٢. **حسم نهائي لـ Mixed Content** (الخيار أ مقترح، تأكيدك مطلوب)
٣. **بدء التطوير من PRD #1** بعد الاتفاق

---

**نهاية PRD #8.**
