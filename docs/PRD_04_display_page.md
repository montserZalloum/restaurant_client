# PRD #4: صفحة الشاشة (Display Page)

> **الغرض من هذا المستند:** تحديد متطلبات صفحة الشاشة التي تعرض أرقام الطلبات للزبائن في المطعم. الصفحة سحابية، تُفتَح على Smart TV، وتُحدَّث لحظياً.

> **المرجعيات:**
> - `decisions_session_04.md`: أقسام ٢.١ - ٢.٧، ٦.٣
> - `decisions_session_02.md`: قسم ٢.٢ (cleared)
> - PRD #3 (السحابة): القسم ٥.٣ (Endpoints الشاشة)، القسم ٦.٣ (WebSocket)

> **التبعيات:** PRD #3 يجب أن يكون مكتمل بحيث الـ endpoints والـ WebSocket متاحة.

---

## ١. النطاق

### ١.١ ما يشمله هذا الـ PRD

- بنية الصفحة الوظيفية (HTML/CSS/JS)
- التحميل الأولي للحالة من السحابة
- اتصال WebSocket والاستماع لأحداث الطلبات
- إدارة حالة الطلبات على الصفحة (preparing/ready)
- التنبيه الصوتي عند انتقال طلب لحالة "جاهز"
- شريط التحذير عند انقطاع الاتصال
- منع التلفزيون من النوم (Wake Lock API)
- شاشة الترحيب الأولى (لتفعيل الصوت)

### ١.٢ ما هو خارج النطاق

- **التصميم البصري** (الألوان، الخطوط، التخطيط الدقيق، الأحجام، الأيقونات)
  - من `decisions_session_04.md` بند ٢.٣: "صاحب المشروع لديه التصميم جاهز"
  - هذا الـ PRD يحدد البنية الوظيفية فقط
- لوحة الإعدادات للشاشة (لا توجد، الإعدادات تُدار من لوحة التحكم السحابية)
- النموذج الهجين (محلي ↔ سحابي) — مؤجَّل للنسخة 2.0 (`decisions_session_04.md` بند ٢.٢)

### ١.٣ المبادئ الموجِّهة

من `decisions_session_04.md`:

- **اللغة:** عربية فقط
- **اختفاء يدوي فقط:** الأرقام لا تختفي تلقائياً، فقط بضغط "تم التسليم" من الموظف
- **لا أوقات تقديرية، لا موقع في الطابور:** فقط الرقم وحالته
- **حدود واضحة للنظام:** نعرض الأرقام، الفيشة الورقية مسؤولية المطعم

---

## ٢. تجربة المستخدم (User Flow)

### ٢.١ التدفق الأول (Setup)

```
الموظف يفتح المتصفح على التلفزيون
         ↓
يكتب رابط: https://display.app.com/{restaurant_id}
         ↓
الصفحة تحمّل وتظهر "ابدأ" (شاشة ترحيب)
         ↓
الموظف يضغط "ابدأ"
         ↓
الصفحة تتصل بـ WebSocket
         ↓
تجلب الحالة الحالية من السحابة
         ↓
تعرض الأرقام في القسمين
         ↓
الصوت أصبح مفعّلاً (autoplay مسموح بعد التفاعل)
         ↓
Wake Lock مفعّل (التلفزيون لا ينام)
```

### ٢.٢ التدفق اليومي

```
الصفحة محمّلة من البارح ولسا فاتحة
         ↓
WebSocket متصل
         ↓
طلب جديد يصل → يظهر في "قيد التحضير"
         ↓
الموظف يضغط "جاهز" من تطبيقه
         ↓
الرقم ينتقل لـ "جاهز" + يصدر صوت تنبيه
         ↓
الزبون يستلم
         ↓
الموظف يضغط "تم التسليم"
         ↓
الرقم يختفي من الشاشة
```

### ٢.٣ تدفق الانقطاع

```
WebSocket ينقطع (مشكلة إنترنت)
         ↓
انتظار 10 ثوانٍ
         ↓
ظهور شريط تحذيري في أعلى الشاشة
         ↓
محاولات إعادة الاتصال (exponential backoff)
         ↓
عند نجاح الاتصال: الشريط يختفي + تُجلَب الحالة الحديثة
```

---

## ٣. هيكل الصفحة

### ٣.١ المناطق الوظيفية

```
┌────────────────────────────────────────┐
│ شريط تحذيري (مخفي افتراضياً)              │ ← (٣.٢)
├────────────────────────────────────────┤
│                                        │
│  ┌──────────────┬──────────────┐       │
│  │              │              │       │
│  │  قيد التحضير  │  جاهز للاستلام │      │ ← (٣.٣)
│  │              │              │       │
│  │   47   53    │   45    49   │       │
│  │   58   61    │   50    52   │       │
│  │              │              │       │
│  └──────────────┴──────────────┘       │
│                                        │
└────────────────────────────────────────┘

(عند التحميل الأول، تظهر شاشة ترحيب فوق كل شي)
```

### ٣.٢ شريط التحذير (Status Banner)

**الحالات:**
- `connected` (افتراضي): مخفي
- `disconnected`: ظاهر، نص "الاتصال منقطع — جاري المحاولة..."

**سلوك الإظهار:**
- يُظهَر بعد **10 ثوانٍ** من فقدان WebSocket (لتجنّب إزعاج الانقطاعات اللحظية)
- يبقى ظاهراً حتى يعود الاتصال
- يختفي فور نجاح إعادة الاتصال

**التفاصيل البصرية (الألوان، الموضع، الحجم) خارج نطاق هذا الـ PRD.**

### ٣.٣ القسمان الرئيسيان

**القسم الأيمن: قيد التحضير**
- يعرض كل الطلبات في حالة `preparing`
- الترتيب: FIFO (الأقدم أولاً)
- Wrap تلقائي عند تجاوز عرض الشاشة

**القسم الأيسر: جاهز للاستلام**
- يعرض كل الطلبات في حالة `ready`
- الترتيب: FIFO (الأقدم أولاً)
- لون/تمييز مختلف عن "قيد التحضير" (التفاصيل في تصميم صاحب المشروع)

**ملاحظة على الترتيب RTL:**
- اللغة عربية، التصميم RTL طبيعي
- "قيد التحضير" على اليمين، "جاهز" على اليسار
- لكن هذه قرارات بصرية — الـ PRD لا يفرضها

### ٣.٤ شاشة الترحيب الأولى

**متى تظهر:**
- عند أول تحميل للصفحة
- بعد إعادة تحميل الصفحة (refresh)
- لا تظهر إذا أُغلقت سابقاً وحُفِظت في `sessionStorage`

**المحتوى:**
- اسم المطعم (يُجلَب من السحابة)
- زر كبير "ابدأ"
- نص توضيحي قصير: "اضغط ابدأ لتفعيل الصوت"

**عند الضغط على "ابدأ":**
1. تشغيل صوت اختبار قصير (لتفعيل audio context)
2. طلب Wake Lock
3. تخزين علامة في `sessionStorage` لعدم إظهارها مرة ثانية
4. إخفاء الشاشة، إظهار الواجهة الرئيسية

**سبب وجود هذه الشاشة:**
المتصفحات تمنع تشغيل الصوت autoplay دون تفاعل المستخدم. ضغطة "ابدأ" تخدم كـ "user gesture" المطلوب.

---

## ٤. التحميل الأولي

### ٤.١ تسلسل التحميل

```javascript
async function initialize() {
  // 1. عرض شاشة الترحيب (لو ما اختفت)
  if (!sessionStorage.getItem('display_started')) {
    showWelcomeScreen()
    await waitForStartClick()
  }
  
  // 2. تشغيل audio test (لتفعيل audio context)
  await playSilentAudio()
  
  // 3. طلب Wake Lock
  await requestWakeLock()
  
  // 4. جلب الحالة الحالية
  const orders = await fetchActiveOrders()
  renderOrders(orders)
  
  // 5. الاتصال بـ WebSocket
  connectWebSocket()
}
```

### ٤.٢ جلب الحالة الحالية

```
GET /api/displays/{restaurant_id}/active-orders
```

**الاستجابة المتوقعة:**
```json
{
  "orders": [
    { "order_number": 47, "status": "preparing", "since": 1746345600000 },
    { "order_number": 49, "status": "ready", "since": 1746345700000 }
  ]
}
```

**عند الفشل:**
- إعادة المحاولة بـ exponential backoff (1s, 2s, 4s, max 30s)
- إظهار شريط التحذير

---

## ٥. اتصال WebSocket

### ٥.١ الاتصال

```javascript
const ws = new WebSocket(`wss://api.queue-manager.com/ws/display/${restaurantId}`)
```

لا مصادقة (`restaurant_id` كافي، read-only).

### ٥.٢ الرسائل المُستقبَلة

**`order_event`:**
```json
{
  "type": "order_event",
  "data": {
    "order_number": 47,
    "status": "ready",
    "at": 1746345900000
  }
}
```

**المعالجة:**
- إيجاد الطلب في الذاكرة المحلية بـ `order_number`
- إذا لم يوجد ولـ status هي `preparing`: إضافته للقسم
- إذا وُجد: تحديث الحالة (نقله بين القسمين أو إزالته)
- إذا الانتقال إلى `ready`: تشغيل صوت تنبيه
- إذا الانتقال إلى `delivered` أو `cancelled` أو `cleared`: إزالته من الواجهة

**`clear_screen`:**
```json
{ "type": "clear_screen" }
```

**المعالجة:** إزالة كل الطلبات من الواجهة (القسمين فاضيين).

**`ping`:**
**المعالجة:** الرد بـ `pong` (heartbeat).

### ٥.٣ إعادة الاتصال

```javascript
let reconnectDelay = 1000  // 1 ثانية
let disconnectTime = null

ws.onclose = () => {
  disconnectTime = Date.now()
  scheduleReconnect()
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)  // max 30s
    connectWebSocket()
  }, reconnectDelay)
}

ws.onopen = () => {
  reconnectDelay = 1000  // reset
  hideDisconnectionBanner()
  
  // عند العودة بعد انقطاع: إعادة جلب الحالة
  if (disconnectTime) {
    fetchActiveOrders().then(renderOrders)
    disconnectTime = null
  }
}
```

### ٥.٤ التحذير عند الانقطاع

```javascript
let bannerTimer = null

ws.onclose = () => {
  bannerTimer = setTimeout(() => {
    showDisconnectionBanner()
  }, 10000)  // 10 ثوانٍ
}

ws.onopen = () => {
  if (bannerTimer) {
    clearTimeout(bannerTimer)
    bannerTimer = null
  }
  hideDisconnectionBanner()
}
```

---

## ٦. إدارة الحالة على الصفحة

### ٦.١ Data Structure

```javascript
const state = {
  preparing: new Map(),  // order_number → { since }
  ready: new Map(),      // order_number → { since }
}
```

استخدام `Map` لكفاءة الإضافة والحذف بمعرفة المفتاح.

### ٦.٢ عمليات التحديث

```javascript
function applyOrderEvent(event) {
  const { order_number, status } = event
  
  // إزالة الطلب من أي مكان موجود فيه
  state.preparing.delete(order_number)
  state.ready.delete(order_number)
  
  // إضافته للحالة الجديدة (إذا كانت معروضة)
  if (status === 'preparing') {
    state.preparing.set(order_number, { since: event.at })
  } else if (status === 'ready') {
    state.ready.set(order_number, { since: event.at })
    playSound()
  }
  // delivered, cancelled, cleared → الطلب يختفي (ما يُضاف لأي قسم)
  
  render()
}
```

### ٦.٣ الـ Rendering

```javascript
function render() {
  const preparingArr = Array.from(state.preparing.entries())
    .sort((a, b) => a[1].since - b[1].since)  // FIFO
    .map(([num]) => num)
  
  const readyArr = Array.from(state.ready.entries())
    .sort((a, b) => a[1].since - b[1].since)
    .map(([num]) => num)
  
  renderPreparingColumn(preparingArr)
  renderReadyColumn(readyArr)
}
```

### ٦.٤ الأداء

- استخدام `requestAnimationFrame` لتجميع التحديثات السريعة
- لا حاجة لـ Virtual DOM (DOM updates مباشرة كافية للحجم المتوقع: < 100 طلب نشط)
- استخدام DOM diffing بسيط (تحديث فقط ما تغيّر)

---

## ٧. التنبيه الصوتي

### ٧.١ المتطلبات

- **متى:** عند انتقال طلب من `preparing` إلى `ready`
- **الصوت:** ملف MP3 قصير (1-2 ثانية)، نمط "ding" أو "تنبيه" بسيط
- **مستوى الصوت:** عالٍ كافٍ ليُسمَع في مطعم بضوضاء معتدلة

### ٧.٢ التنفيذ

```javascript
const audio = new Audio('/sounds/notification.mp3')
audio.preload = 'auto'

function playSound() {
  // إذا الصوت لم يُفعَّل بعد (شاشة الترحيب)
  if (!audioActivated) return
  
  // إعادة تشغيل من البداية إذا كان شغّال
  audio.currentTime = 0
  audio.play().catch(err => {
    console.warn('Failed to play sound:', err)
  })
}
```

### ٧.٣ القيود المقبولة

من `decisions_session_04.md`:

- "best-effort" — لو فشل (متصفح TV قديم، إعدادات غريبة)، النظام يستمر بالعمل صامتاً
- لا تعقيد إضافي للتعامل مع كل سيناريوهات الفشل

### ٧.٤ تفعيل الصوت (Audio Context)

```javascript
async function playSilentAudio() {
  // تشغيل صوت صامت بعد ضغط "ابدأ" لتفعيل audio context
  const silentAudio = new Audio('data:audio/mp3;base64,...')  // 1 sec silence
  await silentAudio.play()
  audioActivated = true
}
```

---

## ٨. Wake Lock

### ٨.١ الغرض

منع التلفزيون من إطفاء الشاشة أو الدخول في وضع توفير الطاقة.

### ٨.٢ التنفيذ

```javascript
let wakeLock = null

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    console.warn('Wake Lock API not supported')
    return
  }
  
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    
    // إذا فُقد الـ lock (مثل تبديل التبويب)، إعادة طلبه عند العودة
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && !wakeLock) {
        await requestWakeLock()
      }
    })
  } catch (err) {
    console.warn('Wake Lock failed:', err)
  }
}
```

### ٨.٣ القيود المقبولة

- بعض متصفحات Smart TV قد لا تدعم Wake Lock API
- في هذه الحالة، التلفزيون قد ينام بعد فترة خمول
- الحل عند الزبون: إعدادات الـ TV نفسه (إيقاف الـ sleep timer)
- هذا يُذكَر في دليل التركيب (PRD #7)

---

## ٩. متطلبات تقنية

### ٩.١ التوافق

- **متصفحات Smart TV الحديثة** (آخر 5 سنوات تقريباً)
- WebSocket support: مطلوب
- HTML5 Audio: مطلوب
- Wake Lock API: مرغوب لكن غير حرج
- ECMAScript 2018+: مقبول (`async/await`, `Map`, إلخ)

### ٩.٢ بدون frameworks

- Vanilla JavaScript فقط
- لا React/Vue/Angular
- **السبب:** Smart TV قد لا يدعم Bundle حديث، وVanilla JS يضمن أوسع توافق
- ملف JS واحد، حجم متوقع: < 50 KB

### ٩.٣ بدون Build Step

- HTML/CSS/JS مباشر، لا webpack ولا Vite
- يجعل النشر بسيط (نسخ ملفات على static hosting)

### ٩.٤ التخزين

- `sessionStorage` فقط (للعلامة "started")
- لا `localStorage` (الشاشة لا تحتاج state دائم بين الـ sessions)
- لا cookies

---

## ١٠. الأمان

### ١٠.١ Content Security Policy

```
Content-Security-Policy:
  default-src 'self';
  connect-src 'self' wss://api.queue-manager.com;
  media-src 'self';
  style-src 'self' 'unsafe-inline';
  script-src 'self';
```

### ١٠.٢ لا معلومات حساسة

- الصفحة public (لا مصادقة)
- لا تعرض أي معلومة حساسة (لا أسماء زبائن، لا أسعار، فقط أرقام)
- `restaurant_id` في الـ URL غير سري

### ١٠.٣ Input Validation

- لا inputs من المستخدم على الصفحة
- لكن: التحقق من شكل الرسائل القادمة من WebSocket (validate شكل JSON)

---

## ١١. الاختبارات المطلوبة

### ١١.١ يدوياً

- [ ] الصفحة تفتح على Smart TV حقيقي (Samsung، LG، Hisense)
- [ ] WebSocket يتصل
- [ ] طلبات تظهر/تختفي بشكل صحيح
- [ ] الصوت يشتغل عند الانتقال لـ ready
- [ ] Wake Lock يمنع النوم لمدة ساعة (تجربة فعلية)
- [ ] قطع الإنترنت → ظهور شريط التحذير بعد 10 ثوانٍ
- [ ] رجوع الإنترنت → الشريط يختفي + الحالة تتزامن
- [ ] إعادة تحميل الصفحة → كل شي يرجع كما كان

### ١١.٢ Edge Cases

- [ ] 50 طلب نشط في نفس الوقت → الواجهة لا تتعطل
- [ ] انقطاع WebSocket لـ 5 دقائق → عند العودة، كل الـ events المتراكمة تُطبَّق بشكل صحيح
- [ ] طلب يصل ثم يُلغى خلال ثانية → يظهر ثم يختفي بشكل سليم
- [ ] فتح الصفحة على شاشتين في نفس المطعم → كلاهما يعرضان نفس البيانات

---

## ١٢. معايير القبول

النسخة المنتهية تعتبر مكتملة إذا حققت كل النقاط التالية:

- [ ] الصفحة تُخدَم من `GET /display/{restaurant_id}` على السحابة
- [ ] شاشة الترحيب تظهر في أول تحميل وتختفي بعد ضغط "ابدأ"
- [ ] الحالة الأولية تُجلَب من `GET /api/displays/{id}/active-orders`
- [ ] WebSocket يتصل بـ `/ws/display/{id}`
- [ ] أحداث `order_event` تُطبَّق بشكل صحيح
- [ ] حدث `clear_screen` يفرّغ الواجهة
- [ ] الصوت يعمل عند الانتقال لـ `ready`
- [ ] Wake Lock يُطلَب عند تفعيل المستخدم
- [ ] شريط التحذير يظهر بعد 10 ثوانٍ من الانقطاع
- [ ] إعادة الاتصال تلقائية مع exponential backoff
- [ ] FIFO ordering في القسمين
- [ ] الصفحة تعمل بدون JavaScript framework
- [ ] الحجم الكلي (HTML+CSS+JS+Audio): < 100 KB
- [ ] CSP و security headers مطبّقة
- [ ] التصميم البصري من صاحب المشروع مدمج

---

## ١٣. الجدول الزمني المتوقع

| اليوم | المهمة |
|------|--------|
| 1 | بنية HTML/CSS الأساسية + شاشة الترحيب |
| 2 | جلب الحالة الأولية + Rendering القسمين |
| 3 | WebSocket connection + معالجة الأحداث |
| 4 | الصوت + Wake Lock + شاشة الانقطاع |
| 5 | إعادة الاتصال + edge cases |
| 6 | اختبار على Smart TV حقيقي + تعديلات |
| 7 | دمج التصميم البصري النهائي + اختبار شامل |

**الإجمالي: 7 أيام عمل تقريبية.**

---

## ١٤. ملاحظات للتطوير

### ١٤.١ اختبار محلي بدون Smart TV

أثناء التطوير، استخدم Chrome على الكمبيوتر بحجم نافذة كبير. لكن:
- اختبار **حقيقي** على Smart TV واحد على الأقل **قبل** التركيب
- لأن متصفحات الـ TV لها quirks (CSS غير مدعوم، JavaScript engines قديمة، إلخ)

### ١٤.٢ المرونة في التصميم

التصميم البصري قد يتغيّر مع الاستخدام. اكتب CSS بطريقة مرنة:
- استخدم CSS variables للألوان والخطوط
- متغيرات يمكن تعديلها لاحقاً من السحابة (إذا قُرر دعم تخصيص)
- في النسخة 1.0، مرّر التصميم كما هو من صاحب المشروع

### ١٤.٣ Static Hosting

الصفحة static تماماً. خيارات النشر:
- **Cloudflare Pages** (مجاني، CDN عالمي)
- **Netlify** (مجاني للحجم الصغير)
- **خدم من نفس السيرفر السحابي** (أبسط في النسخة 1.0)

أنصح بالأخير في النسخة 1.0 لتجنّب إدارة دومينات إضافية.

---

**نهاية PRD #4.**
