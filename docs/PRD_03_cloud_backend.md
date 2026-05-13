# PRD #3: السحابة (Cloud Backend)

> **الغرض من هذا المستند:** تحديد متطلبات البنية السحابية التي تربط البرامج المحلية، شاشات العرض، صفحات الموظفين، ولوحة التحكم. تشمل قاعدة البيانات، REST API، و WebSocket.

> **المرجعيات:**
> - `decisions_session_01.md`: أقسام ٢.١، ٢.٧
> - `decisions_session_02.md`: أقسام ٢.١، ٢.٢، ٥ (Promise.race)، ٧.٢
> - `decisions_session_04.md`: أقسام ٢.٢، ٦.١
> - `decisions_session_05.md`: أقسام ٣.٢، ٣.٥، ٣.٦
> - PRD #2 (شكل أحداث الطلبات + status messages مع LAN IPs)

> **النسخة:** 1.1 — تعديلات لدعم Promise.race لصفحة الموظف:
> - إزالة JWT/session_token (PIN مباشر مع كل request)
> - إضافة `GET /api/staff/active-orders`
> - إضافة `GET /api/staff/connection-info` (لتزويد صفحة الموظف بـ URLs المحلي والسحابي)
> - تتبّع LAN IPs للبرامج المحلية

---

## ١. النطاق

### ١.١ ما يشمله هذا الـ PRD

- قاعدة البيانات وتصميم الـ schema
- REST API للأحداث والإعدادات
- WebSocket لكل المستهلكين (البرنامج المحلي، الشاشة، الموظف)
- المصادقة والتفويض (`api_key`، PIN)
- منطق State Rank Wins على مستوى السحابة
- بث التحديثات للأطراف المتصلة
- تتبّع LAN IPs للبرامج المحلية (لتمكين Promise.race)

### ١.٢ ما هو خارج النطاق

- لوحة التحكم السحابية (Admin UI) — PRD #6
- صفحة الشاشة — PRD #4
- صفحة الموظف — PRD #5
- البرنامج المحلي — PRD #2

### ١.٣ التقنيات المقترحة

- **اللغة:** Node.js
- **Framework:** Fastify
- **قاعدة البيانات:** PostgreSQL
- **WebSocket:** `@fastify/websocket`
- **ORM:** Prisma

---

## ٢. نظرة معمارية شاملة

### ٢.١ المستهلكون والقنوات

```
┌─────────────────────────────────────────────────────────────────┐
│                         السحابة (Backend)                       │
│                                                                 │
│  ┌────────────────┐    ┌────────────────┐    ┌──────────────┐  │
│  │ REST API       │    │ WebSocket      │    │ Database     │  │
│  │ - /api/orders  │    │ - /ws/local    │    │ PostgreSQL   │  │
│  │ - /api/config  │    │ - /ws/display  │    │              │  │
│  │ - /api/staff   │    │ - /ws/staff    │    │              │  │
│  └────────────────┘    └────────────────┘    └──────────────┘  │
└──────┬──────────────────────┬───────────────────────────────────┘
       │                      │
       ↓                      ↓
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Local Agent  │     │ صفحة الشاشة      │     │ صفحة الموظف     │
│ (Restaurant) │     │ (Smart TV)      │     │ (Mobile)         │
│              │     │                 │     │ • سحابي + محلي   │
│              │     │                 │     │ Promise.race     │
└──────────────┘     └─────────────────┘     └──────────────────┘
```

### ٢.٢ مبادئ التصميم

**أ. السحابة هي مصدر الحقيقة للأرشيف، البرنامج المحلي هو مصدر الحقيقة للحاضر.**

**ب. كل اتصال WebSocket مرتبط بمطعم واحد.**

**ج. السحابة "غبية" قدر الإمكان** — تحفظ، تبث، تتحقق من الصلاحيات. لا منطق أعمال معقد.

**د. السحابة تمكّن Promise.race** بتزويد صفحة الموظف بعنوان الاتصال المحلي عند توفّره.

---

## ٣. تصميم قاعدة البيانات

### ٣.١ الجداول

```sql
-- المطاعم
CREATE TABLE restaurants (
  id              VARCHAR(20) PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  api_key         VARCHAR(64) NOT NULL UNIQUE,
  staff_pin       VARCHAR(10) NOT NULL,
  config          JSONB NOT NULL,
  
  -- يتم تحديث هذه الحقول من رسائل status القادمة من البرنامج المحلي
  last_seen_at    TIMESTAMPTZ,
  lan_ips         JSONB,                       -- مصفوفة عناوين IP محلية
  ws_port         INTEGER,                     -- عادةً 9200
  agent_status    JSONB,                       -- آخر معلومات حالة (printer_status, etc.)
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_restaurants_api_key ON restaurants(api_key);

-- الطلبات
CREATE TABLE orders (
  id              UUID PRIMARY KEY,
  restaurant_id   VARCHAR(20) NOT NULL REFERENCES restaurants(id),
  order_number    INTEGER NOT NULL,
  extracted       BOOLEAN NOT NULL DEFAULT true,
  
  status          VARCHAR(20) NOT NULL,
  status_rank     INTEGER NOT NULL,
  
  created_at      TIMESTAMPTZ NOT NULL,
  last_updated    TIMESTAMPTZ NOT NULL,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_restaurant_status ON orders(restaurant_id, status);
CREATE INDEX idx_orders_restaurant_created ON orders(restaurant_id, created_at DESC);

-- تاريخ تغييرات الحالة
CREATE TABLE order_state_history (
  id              BIGSERIAL PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id),
  status          VARCHAR(20) NOT NULL,
  status_rank     INTEGER NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL,
  source          VARCHAR(20) NOT NULL,        -- "local" | "staff_local" | "staff_cloud" | "admin"
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_history_order ON order_state_history(order_id, changed_at);

-- سجل الأحداث (audit log)
CREATE TABLE event_log (
  id              BIGSERIAL PRIMARY KEY,
  restaurant_id   VARCHAR(20) NOT NULL,
  source          VARCHAR(20) NOT NULL,
  event_type      VARCHAR(50) NOT NULL,
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_log_restaurant ON event_log(restaurant_id, received_at DESC);
```

### ٣.٢ ملاحظات على التصميم

- **`lan_ips` و `ws_port`:** تُحدَّث من رسائل status القادمة من البرنامج المحلي عبر WebSocket. تُستخدَم لتزويد صفحة الموظف بعناوين الاتصال المحلية.
- **`last_seen_at`:** آخر مرة تواصل البرنامج مع السحابة. لو أكثر من X دقيقة، نعتبر البرنامج قد يكون offline.
- **`agent_status`:** JSONB حر، يحوي الحالة الحالية (printer_status, active_orders_count, إلخ). للعرض في لوحة التحكم.

### ٣.٣ سياسة الاحتفاظ

| الجدول | المدة |
|--------|-------|
| `restaurants` | للأبد |
| `orders` | للأبد |
| `order_state_history` | للأبد |
| `event_log` | 30 يوم |

---

## ٤. المصادقة والتفويض

### ٤.١ الأنواع الثلاثة

| المُصدِق | المفتاح | الإرسال |
|---------|---------|--------|
| Local Agent | `api_key` | `Authorization: Bearer {key}` |
| Staff | `restaurant_id` + `pin` | Headers مع كل request |
| Display | `restaurant_id` فقط (عام) | في URL |
| Admin | (لاحقاً، PRD #6) | — |

### ٤.٢ Middleware للـ Local Agent

```javascript
async function authenticateLocalAgent(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Bearer token' })
  }
  
  const apiKey = auth.replace('Bearer ', '')
  const restaurant = await db.restaurants.findByApiKey(apiKey)
  
  if (!restaurant || !restaurant.is_active) {
    return reply.code(401).send({ error: 'Invalid api_key' })
  }
  
  request.restaurant = restaurant
}
```

### ٤.٣ Middleware للموظف

**القرار المعتمد:** المصادقة المباشرة بـ PIN في كل request (بدون JWT).

```javascript
async function authenticateStaff(request, reply) {
  const restaurantId = request.headers['x-restaurant-id']
  const pin = request.headers['x-staff-pin']
  
  if (!restaurantId || !pin) {
    return reply.code(401).send({ error: 'Missing credentials' })
  }
  
  const restaurant = await db.restaurants.findById(restaurantId)
  
  if (!restaurant || !restaurant.is_active || restaurant.staff_pin !== pin) {
    return reply.code(401).send({ error: 'Invalid credentials' })
  }
  
  request.restaurant = restaurant
}
```

**سبب اختيار PIN المباشر بدلاً من JWT:**

(من `decisions_session_05.md` بند ٣.٥)

١. **عند تغيير PIN في السحابة، كل الموظفين يُطرَدون فوراً.** مع JWT، الـ token يبقى صالحاً حتى انتهاء صلاحيته.
٢. **بساطة:** لا حاجة لإدارة token expiration وrefresh.
٣. **اتساق مع البرنامج المحلي:** WebSocket المحلي يستخدم نفس آلية PIN.

### ٤.٤ ملاحظات أمنية

**عدم تسريب معلومات في الأخطاء:**
- 401 موحّد ("Invalid credentials") لتجنّب التمييز بين "PIN خاطئ" و "restaurant غير موجود"

**PIN في clear text داخل قاعدة البيانات:**
- لا hashing
- السبب: PIN قصير، الحماية الفعلية = HTTPS + rate limiting

---

## ٥. REST API Endpoints

### ٥.١ Endpoints للـ Local Agent

#### `POST /api/orders/events`

**الغرض:** استقبال batch من أحداث الطلبات.

**المصادقة:** `api_key`

**Request:**
```json
{
  "events": [
    {
      "queue_id": "uuid-from-local-queue",
      "order_id": "uuid",
      "order_number": 47,
      "status": "preparing",
      "status_rank": 1,
      "extracted": true,
      "at": 1746345600000,
      "source": "local"
    }
  ]
}
```

**Response (200):**
```json
{
  "accepted": ["uuid-from-local-queue"],
  "rejected": []
}
```

**المنطق:**
١. لكل event: تحقق، ابحث عن الطلب، طبّق State Rank Wins، أضف history
٢. **بث على WebSocket** لكل المتصلين بهذا المطعم (شاشة + موظف)
٣. أرجع قائمة المقبولة

#### `GET /api/restaurants/{id}/config`

**الغرض:** البرنامج المحلي يجلب أحدث إعدادات (شامل `staff_pin`).

**المصادقة:** `api_key` (يجب أن يطابق المطعم في الـ URL)

**Response (200):**
```json
{
  "version": 1,
  "restaurant": {
    "id": "rest_a8f3k2",
    "name": "...",
    "staff_pin": "483921"
  },
  "cloud": { ... },
  "network": { ... },
  "extractor": { ... },
  "service": { ... },
  "logging": { ... }
}
```

**ملاحظة:** الـ `api_key` لا يُرجَع (البرنامج المحلي يملكه أصلاً).

#### `GET /api/restaurants/{id}/active-orders`

**الغرض:** البرنامج المحلي يجلب الحالة من السحابة عند الإقلاع (للتحقق من المزامنة).

**المصادقة:** `api_key`

**Response:**
```json
{
  "orders": [
    {
      "id": "uuid",
      "order_number": 47,
      "status": "ready",
      "status_rank": 2,
      "created_at": 1746345600000,
      "last_updated": 1746345900000
    }
  ]
}
```

### ٥.٢ Endpoints للموظف

> **ملاحظة:** كل endpoints الموظف تستقبل المصادقة عبر headers:
> - `X-Restaurant-Id: rest_a8f3k2`
> - `X-Staff-Pin: 483921`

#### `POST /api/staff/login`

**الغرض:** التحقق الأولي من PIN عند إدخاله أول مرة.

**Request:**
```json
{
  "restaurant_id": "rest_a8f3k2",
  "pin": "483921"
}
```

**Response (200):**
```json
{
  "valid": true,
  "restaurant": {
    "id": "rest_a8f3k2",
    "name": "..."
  }
}
```

**Response (401):**
```json
{
  "valid": false,
  "error": "Invalid credentials"
}
```

**ملاحظة:** هذا endpoint يُستخدَم فقط للتحقق الأولي وعرض اسم المطعم. لا يُرجِع token. الـ PIN نفسه يُحفَظ في localStorage ويُرسَل في headers مع كل request لاحق.

#### `GET /api/staff/connection-info` (جديد)

**الغرض:** صفحة الموظف تجلب معلومات الاتصال (سحابي + محلي إن توفّر) لتطبيق Promise.race.

**المصادقة:** `restaurant_id` + `pin` في headers

**Response (200):**
```json
{
  "cloud": {
    "ws_url": "wss://api.queue-manager.com/ws/staff"
  },
  "local": {
    "ws_urls": [
      "ws://192.168.1.5:9200",
      "ws://10.0.0.5:9200"
    ],
    "last_seen_at": "2026-05-04T10:23:45Z"
  }
}
```

**المنطق:**

١. تحقق من PIN
٢. اجلب `lan_ips` و `ws_port` و `last_seen_at` من جدول `restaurants`
٣. لو `last_seen_at` أقل من 5 دقائق: زوّد `local.ws_urls`
٤. لو أكبر من 5 دقائق: `local: null` (البرنامج المحلي غير متاح غالباً)

**ملاحظات:**
- صفحة الموظف تجرّب كل عنوان في `ws_urls` بالتوازي مع السحابي
- لو كل المحلية فشلت أو كان `local: null` → استخدام السحابي فقط
- هذا endpoint يُطلَب مرة عند تحميل الصفحة، ويُعاد طلبه دورياً (كل 5 دقائق) لتحديث المعلومات

#### `GET /api/staff/active-orders` (جديد)

**الغرض:** صفحة الموظف تجلب الحالة الحالية عند التحميل.

**المصادقة:** `restaurant_id` + `pin` في headers

**Response (200):**
```json
{
  "orders": [
    {
      "id": "uuid",
      "order_number": 47,
      "status": "preparing",
      "status_rank": 1,
      "since": 1746345600000
    }
  ]
}
```

يُرجَع فقط الطلبات في `preparing` أو `ready`.

#### `POST /api/staff/orders/{order_id}/state`

**الغرض:** تغيير حالة طلب (mark_ready, mark_delivered, cancel).

**المصادقة:** headers

**Request:**
```json
{
  "status": "ready",
  "at": 1746345900000
}
```

**Response (200):**
```json
{
  "order_id": "uuid",
  "status": "ready",
  "status_rank": 2,
  "applied": true
}
```

`applied: false` → الحالة الجديدة لها rank أقل، State Rank Wins رفضها.

**المنطق:**
١. تحقق من المصادقة وملكية الطلب
٢. طبّق State Rank Wins
٣. حدّث الجداول
٤. **بث على WebSocket** لكل المتصلين بالمطعم (شامل البرنامج المحلي)

#### `POST /api/staff/orders/clear-screen`

**الغرض:** زر "تصفير الشاشة".

**Request:**
```json
{ "at": 1746345900000 }
```

**Response (200):**
```json
{ "cleared_count": 12 }
```

### ٥.٣ Endpoints للشاشة (عامة)

#### `GET /display/{restaurant_id}`

**الغرض:** خدمة صفحة HTML للشاشة.

**المصادقة:** لا شيء.

#### `GET /api/displays/{restaurant_id}/active-orders`

**الغرض:** الحالة الأولية عند فتح الشاشة.

**المصادقة:** لا شيء (`restaurant_id` يجب أن يكون active).

**Response:**
```json
{
  "orders": [
    {
      "order_number": 47,
      "status": "preparing",
      "since": 1746345600000
    }
  ]
}
```

---

## ٦. WebSocket Channels

### ٦.١ القنوات الثلاث

| المسار | المتصل | الاتجاه |
|--------|---------|---------|
| `/ws/local-agent` | البرنامج المحلي | ثنائي |
| `/ws/display/{restaurant_id}` | الشاشة | استقبال فقط |
| `/ws/staff` | الموظف | ثنائي |

### ٦.٢ `/ws/local-agent`

#### الاتصال

```
GET /ws/local-agent?restaurant_id={id}&api_key={key}
```

#### الرسائل من السحابة → البرنامج المحلي

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
    "source": "staff_cloud"
  }
}
```

**`settings_updated`:** الأدمن غيّر الإعدادات (شاملاً `staff_pin` احتمالاً)
```json
{ "type": "settings_updated" }
```

**`ping`/`pong`:** heartbeat كل 30 ثانية

#### الرسائل من البرنامج المحلي → السحابة

**`status` (مهم):** يحوي LAN IPs لتمكين Promise.race
```json
{
  "type": "status",
  "data": {
    "lan_ips": ["192.168.1.5"],
    "websocket_port": 9200,
    "active_orders_count": 12,
    "sync_queue_size": 0,
    "printer_status": "ok",
    "uptime_seconds": 3600
  }
}
```

السحابة عند استقبالها:
- تحدّث `restaurants.lan_ips` و `ws_port`
- تحدّث `last_seen_at`
- تحدّث `agent_status` (للعرض في لوحة التحكم)

البرنامج المحلي يبعث `status` كل 5 دقائق + عند تغيّر LAN IPs.

**`pong`:** رد على ping

### ٦.٣ `/ws/display/{restaurant_id}`

#### الاتصال

```
GET /ws/display/rest_a8f3k2
```

#### الرسائل من السحابة → الشاشة

```json
{ "type": "order_event", "data": { "order_number": 47, "status": "ready", "at": ... } }
{ "type": "clear_screen" }
{ "type": "ping" }
```

### ٦.٤ `/ws/staff`

#### الاتصال

```
GET /ws/staff?restaurant_id={id}&pin={pin}
```

التحقق: `restaurant_id` موجود + `pin` صحيح.

#### الرسائل من السحابة → الموظف

نفس رسائل الشاشة (`order_event`, `clear_screen`) **بالإضافة إلى:**

**`printer_status`:**
```json
{
  "type": "printer_status",
  "data": { "status": "failed", "since": 1746345900000 }
}
```

**ملاحظة على شكل الرسائل:** نفس contract الـ WebSocket المحلي (في PRD #2 قسم ٨.٤). هذا يضمن أن صفحة الموظف لا تحتاج معرفة إذا كانت متصلة محلياً أم سحابياً.

#### الرسائل من الموظف → السحابة

**ملاحظة:** الموظف يستخدم REST API للأوامر (أبسط وأكثر موثوقية). WebSocket للاستقبال فقط على الجانب السحابي.

في الجانب المحلي (PRD #2)، الموظف يبعث الأوامر مباشرة عبر WebSocket. هذا التباين سببه أن الـ WebSocket المحلي يسمح بـ stateless commands بدون الحاجة لـ HTTP overhead.

**صفحة الموظف تتعامل مع هذا تلقائياً:**
- لو الاتصال الفائز محلي → ترسل عبر WebSocket
- لو الاتصال الفائز سحابي → ترسل عبر REST API

تفاصيل التطبيق في PRD #5.

---

## ٧. منطق State Rank Wins على السحابة

### ٧.١ التطبيق

```javascript
async function applyOrderEvent(event) {
  const existing = await db.orders.findById(event.order_id)
  
  if (!existing) {
    await db.orders.create({ ...event, synced_at: new Date() })
    await db.orderStateHistory.create({ ...event, source: event.source || 'local' })
    return { applied: true, new: true }
  }
  
  const winner = stateRankWins(existing, event)
  if (winner === existing) {
    return { applied: false }
  }
  
  await db.orders.update(event.order_id, {
    status: event.status,
    status_rank: event.status_rank,
    last_updated: event.at,
    synced_at: new Date()
  })
  await db.orderStateHistory.create({ ...event, source: event.source || 'local' })
  return { applied: true, new: false }
}

function stateRankWins(a, b) {
  if (b.status_rank === 99) return b
  if (a.status_rank === 99) return a
  return b.status_rank > a.status_rank ? b : a
}
```

### ٧.٢ ضمانات

- **Idempotency:** نفس الـ event مرتين → نفس النتيجة
- **Order independence:** الأحداث قد تصل بترتيب مختلف، State Rank Wins يحل

### ٧.٣ تكرار الأحداث في Promise.race

**السيناريو:** الموظف ضغط "جاهز" محلياً. البرنامج المحلي:
1. طبّق محلياً
2. بثّ للموظفين المتصلين محلياً
3. أضاف لـ sync_queue
4. بعد 2 ثواني، بعث للسحابة في الـ batch

السحابة استقبلت → طبّقت → بثّت لكل المتصلين بـ WebSocket السحابي. الموظف نفسه قد يستقبل الحدث مرة ثانية عبر السحابة!

**الحل:** State Rank Wins يضمن أن إعادة التطبيق لا يغيّر الحالة. صفحة الموظف يجب أن تطبّق نفس المنطق (idempotent updates).

---

## ٨. بث التحديثات (Broadcast)

### ٨.١ آلية الـ Broadcasting

```javascript
async function broadcastOrderEvent(restaurantId, event) {
  // البرنامج المحلي
  wsManager.send(`local-agent:${restaurantId}`, {
    type: 'order_event',
    data: event
  })
  
  // الشاشات
  wsManager.broadcast(`display:${restaurantId}`, {
    type: 'order_event',
    data: { order_number: event.order_number, status: event.status, at: event.at }
  })
  
  // الموظفون السحابيون
  wsManager.broadcast(`staff:${restaurantId}`, {
    type: 'order_event',
    data: event
  })
}
```

### ٨.٢ المقياس المتوقع

النسخة 1.0 (10-50 مطعم):
- Local Agents: 50
- Displays: 50-100
- Staff (سحابي + محلي معاً): 50-150 على السحابي + الباقي محلي

**الإجمالي على السحابة:** ~250 اتصال WebSocket. Single instance يكفي.

---

## ٩. الأمان

### ٩.١ HTTPS و WSS

كل الاتصالات السحابية عبر HTTPS / WSS. شهادة من Let's Encrypt.

### ٩.٢ Headers أمنية

```
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: ... (محدد في PRDs #4 و #5)
```

### ٩.٣ Rate Limiting

(من `decisions_session_05.md`: لا rate limit عام في النسخة 1.0)

**استثناء:** rate limit صارم على endpoint الـ login:
- `POST /api/staff/login`: 5 محاولات في الدقيقة لكل IP

### ٩.٤ Input Validation

كل request body يمر بـ JSON schema validation.

### ٩.٥ SQL Injection

- Prisma أو parameterized queries حصرياً
- لا string concatenation أبداً

---

## ١٠. التعامل مع الأخطاء

### ١٠.١ أنواع الأخطاء

| النوع | HTTP | Body |
|------|------|------|
| ValidationError | 400 | `{ error: "validation_failed", details: [...] }` |
| AuthenticationError | 401 | `{ error: "unauthorized" }` |
| NotFoundError | 404 | `{ error: "not_found" }` |
| ConflictError | 409 | `{ error: "conflict" }` |
| RateLimitError | 429 | `{ error: "rate_limit_exceeded", retry_after: 60 }` |
| ServerError | 500 | `{ error: "internal_error", request_id: "..." }` |

### ١٠.٢ Logging

كل request: request_id، restaurant_id، endpoint، status، response time.
كل error 500: stack trace.

---

## ١١. اعتبارات الاستضافة

### ١١.١ المتطلبات الدنيا للنسخة 1.0

- 1 vCPU، 2 GB RAM، 20 GB storage
- PostgreSQL managed
- Domain مع SSL

**التكلفة المتوقعة (10-20 مطعم):** $30-50/شهر.

### ١١.٢ النسخ الاحتياطي

- قاعدة البيانات: backup يومي تلقائي
- الاحتفاظ: 30 يوم

### ١١.٣ المراقبة

- UptimeRobot (مجاني)
- Sentry (مجاني للحجم الصغير)

---

## ١٢. التزامن مع PRDs أخرى

### ١٢.١ ما يحتاجه PRD #4 (الشاشة)

- `GET /display/{restaurant_id}`
- `GET /api/displays/{restaurant_id}/active-orders`
- WebSocket `/ws/display/{restaurant_id}`

### ١٢.٢ ما يحتاجه PRD #5 (الموظف)

- `POST /api/staff/login`
- `GET /api/staff/connection-info`
- `GET /api/staff/active-orders`
- `POST /api/staff/orders/{id}/state`
- `POST /api/staff/orders/clear-screen`
- WebSocket `/ws/staff`

### ١٢.٣ ما يحتاجه PRD #6 (لوحة التحكم)

- Endpoints CRUD للمطاعم
- Endpoint لتحديث `staff_pin`
- Endpoint لتحديث `config`
- Trigger للـ `settings_updated` WebSocket message
- عرض `lan_ips` و `agent_status` للمطعم

### ١٢.٤ ما يحتاجه PRD #2 (البرنامج المحلي)

- Contract كامل لـ `POST /api/orders/events`
- Contract كامل لـ `/ws/local-agent` (شامل `status` message)
- شكل `GET /api/restaurants/{id}/config` (شامل `staff_pin`)

---

## ١٣. معايير القبول

- [ ] قاعدة البيانات منشأة بالـ schema المحدد (شامل `lan_ips`, `ws_port`, `last_seen_at`, `agent_status`)
- [ ] Migrations مكتوبة ومختبرة
- [ ] `POST /api/orders/events` يعمل ويطبّق State Rank Wins
- [ ] `GET /api/restaurants/{id}/config` يعمل (شامل `staff_pin`)
- [ ] `GET /api/restaurants/{id}/active-orders` يعمل
- [ ] `POST /api/staff/login` يعمل بدون JWT (يُرجِع تأكيد فقط)
- [ ] `GET /api/staff/connection-info` يعمل ويُرجِع LAN IPs لو متوفّرة
- [ ] `GET /api/staff/active-orders` يعمل
- [ ] `POST /api/staff/orders/{id}/state` يعمل
- [ ] `POST /api/staff/orders/clear-screen` يعمل
- [ ] `GET /api/displays/{id}/active-orders` يعمل
- [ ] WebSocket `/ws/local-agent` يصادق ويستقبل status messages
- [ ] رسائل `status` تحدّث `restaurants.lan_ips` و `ws_port` و `agent_status`
- [ ] WebSocket `/ws/display/{id}` يبث الأحداث (read-only)
- [ ] WebSocket `/ws/staff` يصادق بـ PIN ويبث
- [ ] إعادة الاتصال WebSocket مدعومة
- [ ] HTTPS و WSS مفعّلان
- [ ] Rate limit على `/api/staff/login`
- [ ] Input validation على كل endpoints
- [ ] Error handling موحّد ومُسجَّل
- [ ] قاعدة البيانات لها backup يومي
- [ ] Broadcast يحدث للأطراف الثلاثة

---

## ١٤. اختبارات مطلوبة

### ١٤.١ Integration Tests

- إنشاء طلب من Local Agent → DB → بث للشاشة والموظف
- الموظف يضغط "ready" → DB → بث للجميع → Local Agent يتحدث
- "تصفير الشاشة" → كل النشطة → cleared
- State Rank Wins:
  - `delivered` ثم `ready` → النتيجة `delivered`
  - `cancelled` فوق `delivered` → النتيجة `cancelled`
- Idempotency: نفس event مرتين → نفس النتيجة
- **`status` message يحدّث LAN IPs:** بعد استقباله، `connection-info` يُرجِع الـ IPs الجديدة
- **تغيير `staff_pin`:** الموظف القديم يحاول request → 401

### ١٤.٢ Load Tests

- 50 Local Agent متصل بـ WebSocket
- 100 event/ثانية موزعة على 10 مطاعم
- Response time للـ POST events: < 100ms p95

---

## ١٥. الجدول الزمني المتوقع

| اليوم | المهمة |
|------|--------|
| 1 | إعداد المشروع (Fastify, Prisma, PostgreSQL) |
| 2 | Schema قاعدة البيانات + migrations (شامل lan_ips, ws_port, etc.) |
| 3 | المصادقة (Local Agent + Staff middleware بـ PIN) |
| 4 | `POST /api/orders/events` + State Rank Wins |
| 5 | `GET /config` + `GET /active-orders` (Local Agent + Display) |
| 6 | Endpoints الموظف (login + state + clear-screen) |
| 7 | `GET /api/staff/connection-info` + `GET /api/staff/active-orders` |
| 8 | WebSocket Manager + قنوات `/ws/local-agent` و `/ws/staff` |
| 9 | معالجة `status` messages وتحديث LAN IPs |
| 10 | WebSocket `/ws/display/{id}` + Broadcasting |
| 11 | معالجة الأخطاء + Logging + Rate limit |
| 12 | اختبارات تكامل + توثيق API |
| 13 | اختبار load + تحسين أداء |
| 14 | نشر على staging environment |

**الإجمالي: 14 يوم عمل تقريبية.**

---

## ١٦. التوازي مع PRD #2

PRD #2 و PRD #3 يمكن تطويرهما بالتوازي بعد الاتفاق على Contracts. نقاط الالتقاء الحرجة:

- شكل `events` في `POST /api/orders/events`
- شكل رسائل WebSocket (`order_event`, `status`)
- شكل `connection-info` response
- صيغة المصادقة (PIN في headers)

أنصح بـ "contract-first development".

---

**نهاية PRD #3 (النسخة 1.1).**
