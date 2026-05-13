# PRD #5: صفحة الموظف (Staff Page)

> **الغرض من هذا المستند:** تحديد متطلبات صفحة الموظف التي يستخدمها موظف الاستلام من الموبايل أو التابلت لإدارة حالات الطلبات.

> **المرجعيات:**
> - `decisions_session_02.md`: قسم ٥ كاملاً (تجربة الموظف)، بند ٧.٣ (شريط فشل الطابعة)
> - `decisions_session_05.md`: قسم ٣.٥ (PIN)
> - PRD #3 (السحابة): القسم ٥.٢ و ٦.٤
> - PRD #2 (البرنامج المحلي): القسم ٩ (Printer Status Broadcaster)

> **التبعيات:** PRD #3 و PRD #2 يجب أن يكونا مكتملين (الـ endpoints والـ WebSocket متاحة محلياً وسحابياً).

---

## ١. النطاق

### ١.١ ما يشمله هذا الـ PRD

- التحقق من PIN ومصادقة الموظف
- بنية الصفحة الوظيفية (HTML/CSS/JS)
- عرض الطلبات في عمودين (preparing / ready)
- أزرار التفاعل (جاهز، تم التسليم، إلغاء، تصفير)
- نوافذ التأكيد (للإلغاء والتصفير)
- شريط تنبيه فشل الطابعة
- **اتصال هجين:** محلي وسحابي بالتوازي بـ Promise.race
- اكتشاف العنوان المحلي
- التبديل التلقائي بين القناتين عند فشل أحدهما

### ١.٢ ما هو خارج النطاق

- **التصميم البصري التفصيلي**
- تطبيق موبايل native
- إشعارات Push

### ١.٣ المبادئ الموجِّهة

من `decisions_session_02.md`:

- **بطاقة طلب مبسطة:** رقم فقط
- **أزرار بدون تأكيد للأفعال المتكررة** (جاهز، تم التسليم)
- **تأكيد للأفعال النادرة** (إلغاء بسيط، تصفير مزدوج)
- **FIFO:** الأقدم أولاً
- **scroll مستقل لكل عمود**
- **`100svh`** (ملء الشاشة)
- **اتصال متوازٍ:** محلي وسحابي معاً، Promise.race يحدد الفائز

---

## ٢. الاتصال الهجين (Promise.race)

### ٢.١ المبدأ

من `decisions_session_02.md` بند ٥: "تتصل بالقناتين المحلية والسحابية بالتوازي".

الصفحة تفتح **اتصالَين WebSocket في نفس الوقت:**

١. **محلي:** `ws://{local_ip}:9200` — يصل لـ Local Agent مباشرة
٢. **سحابي:** `wss://api.queue-manager.com/ws/staff` — عبر الإنترنت

### ٢.٢ السيناريوهات الأربعة

| السيناريو | المحلي | السحابي | السلوك |
|-----------|--------|---------|---------|
| موبايل على واي فاي المطعم + إنترنت شغّال | ✓ | ✓ | كلاهما متصل، المحلي أولوية (أسرع) |
| موبايل على واي فاي المطعم + إنترنت مقطوع | ✓ | ✗ | المحلي فقط، النظام شغّال |
| موبايل على شبكة الخلوي + إنترنت شغّال | ✗ | ✓ | السحابي فقط، النظام شغّال |
| موبايل على الخلوي + سحابة معطّلة | ✗ | ✗ | لا اتصال (نادر جداً) |

**النتيجة:** ٣ من ٤ سيناريوهات = النظام شغّال.

### ٢.٣ اكتشاف العنوان المحلي

**المشكلة:** الصفحة تُحمَّل من السحابة، لكن تحتاج معرفة الـ IP المحلي للـ Local Agent.

**الحل:** الـ Local Agent يُبلغ السحابة بعنوانه المحلي، والسحابة تمرّره للصفحة.

#### ٢.٣.١ على البرنامج المحلي

عند الاتصال بـ WebSocket السحابي، يرسل status فيه:

```json
{
  "type": "status",
  "data": {
    "lan_ip": "192.168.1.88",
    "local_ws_port": 9200
  }
}
```

البرنامج يكتشف عنوانه المحلي عبر:
```javascript
const interfaces = require('os').networkInterfaces()
const lan_ip = findFirstNonInternalIPv4(interfaces)
```

#### ٢.٣.٢ على السحابة

endpoint جديد:

```
GET /api/staff/connection-info
Headers: X-Restaurant-Id, X-Staff-Pin
```

**الاستجابة:**
```json
{
  "cloud_ws": "wss://api.queue-manager.com/ws/staff",
  "local_ws": "ws://192.168.1.88:9200/staff",
  "lan_ip_last_seen": 1746345600000
}
```

`lan_ip_last_seen` يخبر الصفحة متى آخر مرة وصلت معلومة الـ IP. لو قديمة (> 5 دقائق)، نتجاهل المحلي.

### ٢.٤ آلية Promise.race

```javascript
async function connectHybrid() {
  const info = await getConnectionInfo()
  
  const cloudPromise = connectWS(info.cloud_ws)
  const localPromise = info.local_ws ? connectWS(info.local_ws) : Promise.reject()
  
  // الفائز يصبح primary
  const winner = await Promise.race([
    cloudPromise.then(ws => ({ type: 'cloud', ws })),
    localPromise.then(ws => ({ type: 'local', ws })).catch(() => null)
  ])
  
  primary = winner
  startListening(primary)
  
  // الثاني يصبح secondary (احتياط)
  const otherPromise = winner.type === 'cloud' ? localPromise : cloudPromise
  otherPromise.then(ws => {
    secondary = { type: winner.type === 'cloud' ? 'local' : 'cloud', ws }
  }).catch(() => {})
}
```

### ٢.٥ التبديل التلقائي عند الفشل

```javascript
primary.ws.onclose = () => {
  if (secondary?.ws.readyState === WebSocket.OPEN) {
    primary = secondary
    secondary = null
    showInfoToast(`تم التحويل للاتصال ${primary.type === 'local' ? 'المحلي' : 'السحابي'}`)
    startListening(primary)
    scheduleReconnect()
  } else {
    showDisconnectionBanner()
    scheduleReconnect()
  }
}
```

### ٢.٦ إرسال الأوامر

```javascript
async function sendCommand(orderId, status) {
  // 1. محاولة محلية (إذا متاحة)
  const localWs = getLocalWsIfOpen()
  if (localWs) {
    localWs.send(JSON.stringify({
      type: 'order_command',
      data: { order_id: orderId, status, at: Date.now(), pin }
    }))
    return
  }
  
  // 2. fallback سحابي عبر REST
  await fetch(`/api/staff/orders/${orderId}/state`, {
    method: 'POST',
    headers: { 'X-Restaurant-Id': restId, 'X-Staff-Pin': pin },
    body: JSON.stringify({ status, at: Date.now() })
  })
}
```

**فائدة الإرسال المحلي:** أسرع، يعمل بدون إنترنت.

**ملاحظة:** الـ Local Agent عند استقبال أمر، يطبّقه ويبثه للجميع (موظفون آخرون، شاشة، السحابة عند توفر الإنترنت).

### ٢.٧ Deduplication

عند الاتصال بقناتين، قد يصل نفس الحدث مرتين. كل event له `event_id` فريد:

```javascript
const seenEvents = new Set()
const MAX_SEEN = 100

function handleEvent(event) {
  if (seenEvents.has(event.event_id)) return
  
  seenEvents.add(event.event_id)
  if (seenEvents.size > MAX_SEEN) {
    const first = seenEvents.values().next().value
    seenEvents.delete(first)
  }
  
  applyOrderEvent(event)
}
```

---

## ٣. تجربة المستخدم

### ٣.١ التدفق الأول

```
الموظف يفتح: https://staff.app.com/{restaurant_id}
         ↓
شاشة طلب PIN
         ↓
الموظف يدخل PIN → السحابة تتحقق
         ↓
PIN يُحفَظ في localStorage
         ↓
جلب connection-info من السحابة
         ↓
Promise.race على القناتين
         ↓
عند نجاح أي منهما: جلب الحالة + بدء الاستماع
```

### ٣.٢ تدفق انقطاع الإنترنت

```
الإنترنت ينقطع
         ↓
السحابي WebSocket يفقد الاتصال
         ↓
الموبايل (على واي فاي المطعم) لا يزال متصلاً بالـ Local Agent
         ↓
النظام يعمل بشكل كامل
         ↓
الإنترنت يرجع
         ↓
السحابي يعيد الاتصال + المزامنة تحصل
```

---

## ٤. هيكل الصفحة

### ٤.١ المناطق الوظيفية

```
┌──────────────────────────────────────┐
│ شريط تنبيه فشل الطابعة (مخفي افتراضياً)  │
├──────────────────────────────────────┤
│ Header: [اسم المطعم] [● local] [⋮]    │
├──────────────────────────────────────┤
│  ┌────────────┬────────────┐         │
│  │  قيد        │  جاهز       │         │
│  │  التحضير    │  للاستلام   │       │
│  │            │            │         │
│  │ ┌────────┐ │ ┌────────┐ │         │
│  │ │   47   │ │ │   45   │ │         │
│  │ │ [جاهز] │ │ │ [تم    │ │         │
│  │ └────────┘ │ │ التسليم]│ │         │
│  │ ↕ scroll   │ ↕ scroll   │         │
│  └────────────┴────────────┘         │
└──────────────────────────────────────┘
```

التخطيط `100svh` (scroll مستقل لكل عمود).

### ٤.٢ شريط تنبيه فشل الطابعة

من `decisions_session_02.md` بند ٣.٥:

- مخفي افتراضياً
- يظهر عند `printer_status: failed` من القناة المحلية
- نص واضح: "الطابعة غير متصلة"
- يبقى ظاهراً حتى استقبال `printer_status: ok`
- لا أصوات، لا إشعارات منبثقة

### ٤.٣ Header

- اسم المطعم
- **مؤشر الاتصال:**
  - 🟢 محلي + سحابي (مثالي)
  - 🔵 محلي فقط (لا إنترنت لكن النظام شغّال)
  - 🟡 سحابي فقط (الموظف على الخلوي، النظام شغّال)
  - 🔴 لا اتصال
- زر ⋮ يفتح قائمة الإجراءات

### ٤.٤ العمودان

**قيد التحضير (يمين):** طلبات `preparing`، FIFO، بطاقة فيها رقم + زر "جاهز"

**جاهز للاستلام (يسار):** طلبات `ready`، FIFO، بطاقة فيها رقم + زر "تم التسليم"

### ٤.٥ بطاقة الطلب

```
┌──────────────────────┐
│        47            │  ← رقم بحجم كبير
│   [   جاهز   ]       │  ← زر بحجم كبير
└──────────────────────┘
```

من `decisions_session_02.md` بند ٥: رقم + زر، لا تفاصيل أخرى.

### ٤.٦ الأزرار الأساسية (بدون تأكيد)

من `decisions_session_02.md` بند ٥ و٦.٤:

**"جاهز":** ضغطة → الطلب ينتقل لقسم "جاهز" فوراً.

**"تم التسليم":** ضغطة → الطلب يختفي.

كلاهما **بدون تأكيد** (متكرران، قابلان للتراجع عبر الإلغاء).

### ٤.٧ قائمة الإجراءات (Header Menu)

عند الضغط على ⋮:

**١. إلغاء طلب** — modal فيه قائمة الطلبات النشطة → اختيار → تأكيد بسيط

**٢. تصفير الشاشة** — تأكيد مزدوج:
- الخطوة 1: "سيتم إزالة 12 طلب نشط. لا يمكن التراجع."
- الخطوة 2: "اضغط 'تصفير الآن' للتأكيد"

**٣. تسجيل خروج** — يمسح PIN من localStorage

### ٤.٨ التأكيد المتناسب

| الخطر | التأكيد |
|-------|---------|
| متكرر، قابل للتراجع | بدون |
| نادر، طلب واحد | بسيط |
| نادر، عدة طلبات | مزدوج مع تفاصيل |

---

## ٥. تدفق المصادقة (PIN)

### ٥.١ شاشة طلب PIN

- 6 خانات
- Keyboard رقمي تلقائي (`inputmode="numeric"`)
- التحقق فوري عند إدخال الرقم السادس

### ٥.٢ التحقق

```javascript
async function verifyPin(pin) {
  const response = await fetch('/api/staff/login', {
    method: 'POST',
    body: JSON.stringify({ restaurant_id, pin })
  })
  
  if (response.ok) {
    localStorage.setItem('staff_pin', pin)
    return true
  }
  return false
}
```

### ٥.٣ تخزين PIN في localStorage

من `decisions_session_05.md` بند ٣.٥:

نخزّن **PIN نفسه** في localStorage، نرسله مع كل request.

**سبب التفضيل على JWT:**
- عند تغيير PIN في السحابة، كل الموظفين القدامى يُطرَدون فوراً
- بساطة (لا token expiration management)
- PIN ليس سرّاً عالي القيمة (حماية معقولة بدون تعقيد)

```javascript
// مع كل HTTP request
fetch('/api/staff/orders/123/state', {
  headers: { 
    'X-Restaurant-Id': restaurantId,
    'X-Staff-Pin': localStorage.getItem('staff_pin')
  },
  ...
})

// مع WebSocket (عند الاتصال)
const cloudWs = new WebSocket(
  `wss://api.queue-manager.com/ws/staff?restaurant_id=${id}&pin=${pin}`
)

// مع كل أمر عبر WebSocket محلي
localWs.send(JSON.stringify({
  type: 'order_command',
  data: { ..., pin }
}))
```

### ٥.٤ معالجة 401

```javascript
if (response.status === 401) {
  localStorage.removeItem('staff_pin')
  window.location.reload()
}
```

---

## ٦. التحميل الأولي

```javascript
async function initialize() {
  // 1. PIN check
  const pin = localStorage.getItem('staff_pin')
  if (!pin) { showPinScreen(); return }
  
  const valid = await verifyPin(pin)
  if (!valid) { localStorage.removeItem('staff_pin'); showPinScreen(); return }
  
  // 2. جلب الطلبات النشطة
  const orders = await fetchActiveOrders()
  renderOrders(orders)
  
  // 3. الاتصال الهجين
  await connectHybrid()
  
  hideLoadingScreen()
}
```

### ٦.١ Endpoint جلب الطلبات النشطة

```
GET /api/staff/active-orders
Headers: X-Restaurant-Id, X-Staff-Pin
```

**ملاحظة:** هذا endpoint يحتاج إضافة لـ PRD #3 (لم يكن موجوداً).

---

## ٧. WebSocket — كلتا القناتين

### ٧.١ الرسائل المُستقبَلة

من **كلا القناتين**:

**`order_event`:**
```json
{
  "type": "order_event",
  "event_id": "uuid",
  "data": {
    "order_id": "uuid",
    "order_number": 47,
    "status": "ready",
    "at": 1746345900000
  }
}
```

**`clear_screen`:**
```json
{ "type": "clear_screen", "event_id": "uuid" }
```

من **القناة المحلية فقط**:

**`printer_status`:**
```json
{
  "type": "printer_status",
  "data": { "status": "failed", "since": 1746345900000 }
}
```

`ping`/`pong` heartbeat.

### ٧.٢ Deduplication

كل event له `event_id`. الصفحة تحفظ آخر 100 event_id وتتجاهل المكررات (انظر القسم ٢.٧).

### ٧.٣ إعادة الاتصال

كل قناة تحاول إعادة الاتصال **بشكل مستقل** (exponential backoff: 1s, 2s, 4s, max 30s).

عند نجاح إعادة الاتصال: تحديث المؤشر، إعادة جلب الحالة لو حصل انقطاع طويل.

---

## ٨. إدارة الحالة على الصفحة

### ٨.١ Data Structure

```javascript
const state = {
  preparing: new Map(),  // order_id → { number, since }
  ready: new Map()
}
```

### ٨.٢ تطبيق الأحداث

```javascript
function applyOrderEvent(event) {
  const { order_id, order_number, status } = event
  
  state.preparing.delete(order_id)
  state.ready.delete(order_id)
  
  if (status === 'preparing') {
    state.preparing.set(order_id, { number: order_number, since: event.at })
  } else if (status === 'ready') {
    state.ready.set(order_id, { number: order_number, since: event.at })
  }
  
  render()
}
```

### ٨.٣ Optimistic Updates

```javascript
async function markAsReady(orderId) {
  // 1. تحديث الواجهة فوراً
  const order = state.preparing.get(orderId)
  if (order) {
    state.preparing.delete(orderId)
    state.ready.set(orderId, order)
    render()
  }
  
  // 2. الإرسال (محلي إن أمكن، وإلا سحابي)
  try {
    await sendCommand(orderId, 'ready')
  } catch (err) {
    // 3. التراجع
    state.ready.delete(orderId)
    state.preparing.set(orderId, order)
    render()
    showErrorToast('فشل تحديث الطلب')
  }
}
```

---

## ٩. الإجراءات (Actions)

### ٩.١ "جاهز"
بدون تأكيد → `sendCommand(orderId, 'ready')`

### ٩.٢ "تم التسليم"
بدون تأكيد → `sendCommand(orderId, 'delivered')`

### ٩.٣ إلغاء
تأكيد بسيط → `sendCommand(orderId, 'cancelled')`

### ٩.٤ تصفير الشاشة

```javascript
async function onClearScreenClick() {
  const count = state.preparing.size + state.ready.size
  if (count === 0) { showInfoToast('لا توجد طلبات نشطة'); return }
  
  // التأكيد الأول
  const first = await showConfirmModal({
    title: 'تصفير الشاشة',
    message: `سيتم إزالة ${count} طلب نشط. لا يمكن التراجع.`,
    confirmText: 'متابعة'
  })
  if (!first) return
  
  // التأكيد الثاني
  const second = await showConfirmModal({
    title: 'تأكيد أخير',
    message: 'اضغط "تصفير الآن" للتأكيد.',
    confirmText: 'تصفير الآن'
  })
  if (!second) return
  
  await sendClearCommand()
}
```

---

## ١٠. متطلبات تقنية

### ١٠.١ التوافق

- iOS Safari 14+
- Android Chrome 90+

### ١٠.٢ مشكلة Mixed Content (تحدٍ معماري حقيقي)

**المشكلة:** الصفحة تُحمَّل من HTTPS (السحابة)، لكن الاتصال المحلي على `ws://` (غير مشفر). المتصفحات الحديثة **تمنع** هذا.

**الحلول الممكنة:**

**أ. الـ Local Agent يخدم نسخة من الصفحة محلياً على HTTP**

عند الاتصال على واي فاي المطعم، الموظف يفتح:
```
http://192.168.1.88:9200/staff
```
عند الخلوي:
```
https://staff.app.com/{restaurant_id}
```

**التبعة:** نوزّع رابطين، الموظف يختار حسب الموقع.

**ب. self-signed certificate على Local Agent**

الـ Local Agent يولّد شهادة محلياً، الموظف يقبلها مرة واحدة على موبايله. WSS يصير ممكناً.

**التبعة:** الموبايل يحتاج قبول الشهادة (تحذير أمني مرعب للموظف).

**ج. تجاهل المحلي على HTTPS، استخدام السحابي فقط من الصفحة السحابية**

السحابة تخدم نسخة سحابية فقط. الـ Local Agent يخدم نسخة محلية فيها Promise.race.

**التبعة:** نوزّع رابطين، لكن النسخة المحلية فيها كل المزايا.

#### القرار المقترح للنسخة 1.0

**الحل أ (نسخة محلية + سحابية):**
- الـ Local Agent يخدم HTML/CSS/JS الصفحة محلياً (يحتاج HTTP server محلي)
- النسخة المحلية تحاول local + cloud (Promise.race كامل)
- النسخة السحابية تستخدم cloud فقط (بدون مزايا local)
- نوزّع رابطين، نشرحهما للموظف

هذا يتطلب تحديثاً في PRD #2 و PRD #1 لإضافة HTTP server محلي.

**هذا القرار يحتاج تأكيد من صاحب المشروع قبل التنفيذ.**

### ١٠.٣ Responsive

- Mobile portrait: 360x640+
- Mobile landscape: 640x360+
- Tablet: 768x1024+

### ١٠.٤ الأداء

- First Contentful Paint: < 1.5s على 4G
- ضغط الزر → استجابة الواجهة: < 50ms
- حجم الـ bundle: < 100 KB

### ١٠.٥ Frameworks

أنصح بـ **Preact** (3 KB) لإدارة حالة أنظف، أو Vanilla JavaScript للأبسط.

### ١٠.٦ PWA

- `manifest.json` لـ "Add to Home Screen"
- لا Service Worker في النسخة 1.0

---

## ١١. الأمان

### ١١.١ CSP (للنسخة السحابية)

```
Content-Security-Policy:
  default-src 'self';
  connect-src 'self' wss://api.queue-manager.com;
  style-src 'self' 'unsafe-inline';
  script-src 'self';
```

### ١١.٢ XSS Prevention

- لا `innerHTML` لمحتوى من السحابة أو المحلي
- استخدام `textContent` أو escape محكم

### ١١.٣ Mixed Content

كما هو موضح في ١٠.٢، الحل المعتمد (نسختان: محلية + سحابية) يتجنّب هذه المشكلة.

---

## ١٢. التغييرات المطلوبة في PRDs أخرى

### ١٢.١ في PRD #1

- (في حالة الحل أ من ١٠.٢): إضافة HTTP server محلي على الـ Local Agent

### ١٢.٢ في PRD #2

- **إضافة WebSocket endpoint محلي على `/staff`** يقبل اتصالات الموظفين بـ PIN
- **إضافة معالجة `order_command`** من الموظف عبر WebSocket المحلي
- **إضافة إرسال `lan_ip` للسحابة** كجزء من رسالة status
- (في حالة الحل أ من ١٠.٢): إضافة HTTP server يخدم صفحة الموظف من الذاكرة

### ١٢.٣ في PRD #3

- **تغيير `/api/staff/login`** ليرجع `{ valid: true }` فقط (بدلاً من session_token)
- **إزالة JWT/session_token** من باقي الـ endpoints (استخدام PIN مباشرة)
- **إضافة `GET /api/staff/active-orders`** (مفقود حالياً)
- **إضافة `GET /api/staff/connection-info`** (يرجع cloud_ws و local_ws)
- **استقبال وحفظ `lan_ip`** من البرنامج المحلي عبر status message
- **إضافة `event_id`** لكل event يُبَث (للـ deduplication)

---

## ١٣. معايير القبول

النسخة المنتهية تعتبر مكتملة إذا حققت كل النقاط التالية:

- [ ] شاشة PIN تظهر وتتحقق
- [ ] PIN يُحفَظ في localStorage
- [ ] الـ headers (X-Staff-Pin) ترسل مع كل request
- [ ] 401 يمسح PIN ويعيد للشاشة
- [ ] جلب connection-info من السحابة يعمل
- [ ] Promise.race يفتح القناتين بالتوازي
- [ ] الاتصال يعمل في السيناريوهات الأربعة
- [ ] التبديل التلقائي بين القنوات عند الفشل
- [ ] Deduplication بـ event_id يعمل
- [ ] مؤشر الاتصال يعكس الحالة الصحيحة
- [ ] العمودان يعرضان بـ FIFO
- [ ] أزرار "جاهز" و"تم التسليم" تعمل بدون تأكيد
- [ ] الإلغاء مع تأكيد بسيط يعمل
- [ ] التصفير مع تأكيد مزدوج يعمل
- [ ] شريط فشل الطابعة يظهر/يختفي
- [ ] Optimistic updates مع التراجع عند الفشل
- [ ] إعادة الاتصال تلقائية لكل قناة بشكل مستقل
- [ ] حل لمشكلة Mixed Content معتمد ومطبّق
- [ ] الأوامر تُرسَل محلياً عند توفر القناة المحلية

---

## ١٤. الجدول الزمني المتوقع

| اليوم | المهمة |
|------|--------|
| 1 | إعداد المشروع + شاشة PIN |
| 2 | بنية الصفحة + العمودان |
| 3 | بطاقات الطلب + الأزرار الأساسية |
| 4 | اتصال WebSocket سحابي + معالجة الأحداث |
| 5 | اتصال WebSocket محلي + Promise.race |
| 6 | تطبيق حل Mixed Content + التبديل التلقائي |
| 7 | Deduplication + مؤشر الاتصال |
| 8 | الإجراءات (إلغاء، تصفير) + التأكيدات |
| 9 | شريط فشل الطابعة + Optimistic updates |
| 10 | اختبار في الأربع سيناريوهات |
| 11 | اختبار على موبايل حقيقي |
| 12 | دمج التصميم البصري + اختبار شامل |

**الإجمالي: 12 يوم عمل تقريبية.**

---

## ١٥. ملاحظة صريحة على التعقيد

النموذج الهجين أعقد من السحابي فقط بـ **3 أيام عمل تقريبية**. التعقيدات:

- إدارة قناتين بدلاً من واحدة
- Deduplication
- التبديل التلقائي
- اكتشاف العنوان المحلي
- **مشكلة Mixed Content** (تحتاج قرار معماري في ١٠.٢)

**التعقيد مبرّر** لأن الفائدة (المطعم لا يتعطل بسبب انقطاع الإنترنت) جوهرية في السوق المستهدف (الأردن، الإنترنت غير موثوق دائماً)، ومتسقة مع `decisions_session_02.md` بند ٥.

---

**نهاية PRD #5 (النسخة المعدّلة).**
