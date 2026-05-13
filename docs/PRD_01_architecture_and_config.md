# PRD #1: البنية المعمارية والإعدادات

> **الغرض من هذا المستند:** تحديد البنية المعمارية الأساسية للنسخة 1.0 من نظام إدارة طوابير المطاعم، وآلية إدارة الإعدادات. هذا المستند هو الأساس الذي تبني عليه كل الـ PRDs الأخرى، ويُقرأ قبلها.

> **المرجعيات:** يستند هذا المستند على القرارات في `decisions_session_01.md` (أقسام ٢.١، ٢.٧، ٣.٢) و `decisions_session_03.md` (أقسام ٢.١، ٢.٢، ٢.٣) و `decisions_session_05.md` (قسم ٣.٥).

> **النسخة:** 1.1 — تعديلات لدعم Promise.race لصفحة الموظف (`staff_pin` في config، `getLocalIpAddresses` في PlatformAdapter، خادم WebSocket محلي للموظف).

---

## ١. النطاق

### ١.١ ما يشمله هذا الـ PRD

- بنية مجلدات المشروع
- تعريف واجهة `PlatformAdapter` (Contract)
- تطبيق `PlatformAdapter` لويندوز (هيكلي فقط — التنفيذ الفعلي في PRD #2 و PRD #7)
- نظام إدارة الإعدادات (`config.json`)
- آلية التركيب الأولي وجلب الإعدادات من السحابة
- آلية تحديث الإعدادات أثناء التشغيل
- طبقة التخزين المحلي (JSON Lines)
- طبقة التسجيل (Logging) الأساسية
- طبقة الفحص الذاتي (Health Check) الأساسية

### ١.٢ ما هو خارج النطاق

- منطق اعتراض الطباعة (PRD #2)
- منطق استخراج رقم الطلب (PRD #2)
- خادم WebSocket المحلي للموظف (PRD #2)
- نقاط نهاية السحابة (PRD #3)
- واجهة الموظف (PRD #5)
- واجهة الشاشة (PRD #4)
- لوحة التحكم السحابية (PRD #6)
- سكريبت `install.bat` والتركيب الفعلي (PRD #7)

---

## ٢. بنية المجلدات النهائية

```
queue-manager/
│
├── src/
│   ├── core/                          ← المنطق الجوهري (مستقل عن نظام التشغيل)
│   │   ├── interceptor/               ← سيُملأ في PRD #2
│   │   ├── extractor/                 ← سيُملأ في PRD #2
│   │   ├── orders/                    ← إدارة حالات الطلبات
│   │   │   ├── store.js
│   │   │   ├── states.js              ← preparing, ready, delivered, cancelled, cleared
│   │   │   └── rank.js                ← منطق State Rank Wins
│   │   ├── sync/                      ← المزامنة مع السحابة
│   │   │   ├── client.js
│   │   │   ├── queue.js
│   │   │   └── settings-listener.js
│   │   └── websocket/                 ← خادم WebSocket المحلي للموظف
│   │       ├── server.js              ← يستمع على local_server.websocket_port
│   │       ├── auth.js                ← التحقق من PIN
│   │       └── handlers.js            ← معالجة أوامر الموظف
│   │
│   ├── platform/                      ← الطبقة المعتمدة على نظام التشغيل
│   │   ├── interface.js               ← Contract موثق (انظر القسم ٣)
│   │   ├── index.js                   ← يختار التطبيق حسب process.platform
│   │   ├── windows/
│   │   │   ├── adapter.js
│   │   │   ├── service.js
│   │   │   ├── network.js
│   │   │   ├── firewall.js
│   │   │   ├── paths.js
│   │   │   └── logging.js
│   │   └── linux/
│   │       └── README.md              ← "محجوز للمستقبل"
│   │
│   ├── storage/
│   │   └── jsonl-store.js
│   │
│   ├── config/
│   │   ├── loader.js
│   │   ├── updater.js
│   │   └── schema.js
│   │
│   ├── logging/
│   │   └── logger.js
│   │
│   ├── health/
│   │   └── checker.js
│   │
│   └── index.js
│
├── config/
│   ├── config.example.json
│   └── rules-library.json
│
├── scripts/
│   ├── install.bat
│   ├── uninstall.bat
│   └── test-printer.bat
│
├── tests/
├── docs/
│
├── package.json
└── README.md
```

### ٢.١ قاعدة الاستيراد الجوهرية

**الكود في `src/core/` لا يستورد من `src/platform/windows/` مباشرة أبداً.** يستورد فقط من `src/platform/index.js`.

```javascript
// src/platform/index.js
const platform = process.platform === 'win32'
  ? require('./windows/adapter')
  : (() => { throw new Error('Unsupported platform') })()

module.exports = platform
```

---

## ٣. واجهة `PlatformAdapter`

### ٣.١ التعريف الكامل

```javascript
// src/platform/interface.js

class PlatformAdapter {

  // ═══════════════════════════════════════════════
  // المسارات
  // ═══════════════════════════════════════════════

  getDataDir() { throw new Error('Not implemented') }
  getConfigDir() { throw new Error('Not implemented') }
  getLogDir() { throw new Error('Not implemented') }

  // ═══════════════════════════════════════════════
  // الخدمة
  // ═══════════════════════════════════════════════

  installAsService(options) { throw new Error('Not implemented') }
  uninstallService() { throw new Error('Not implemented') }
  isServiceInstalled() { throw new Error('Not implemented') }

  // ═══════════════════════════════════════════════
  // اعتراض الطباعة
  // ═══════════════════════════════════════════════

  setupPrintInterception(config) { throw new Error('Not implemented') }
  teardownPrintInterception() { throw new Error('Not implemented') }

  // ═══════════════════════════════════════════════
  // Firewall
  // ═══════════════════════════════════════════════

  configureFirewall(rules) { throw new Error('Not implemented') }

  // ═══════════════════════════════════════════════
  // معلومات الشبكة
  // ═══════════════════════════════════════════════

  /**
   * الحصول على عناوين IP المحلية للجهاز (LAN IPs).
   * يُستخدَم لإبلاغ السحابة بعناوين الاتصال المحلي ليتمكن موبايل الموظف
   * من الاتصال بالبرنامج المحلي مباشرة عبر شبكة المطعم.
   *
   * يجب استثناء loopback (127.0.0.1) و virtual interfaces.
   *
   * @returns {Array<string>} - مصفوفة عناوين IP (مثل ["192.168.1.5"])
   */
  getLocalIpAddresses() { throw new Error('Not implemented') }

  // ═══════════════════════════════════════════════
  // Logging على مستوى النظام
  // ═══════════════════════════════════════════════

  logSystemEvent(level, message) { throw new Error('Not implemented') }
}

module.exports = PlatformAdapter
```

### ٣.٢ ما لا يحتاج تجريد

العمليات التالية تستخدم Node.js APIs قياسية وتبقى في `core/`:

- TCP, WebSocket, HTTP
- قراءة/كتابة الملفات
- Regex, JSON parsing

**القاعدة:** التجريد المبالغ فيه أسوأ من قلة التجريد. نجرّد فقط ما يختلف فعلياً بين الأنظمة.

---

## ٤. نظام إدارة الإعدادات

### ٤.١ Schema ملف `config.json`

```json
{
  "version": 1,
  "restaurant": {
    "id": "rest_a8f3k2",
    "name": "مطعم الاختبار - فرع الجامعة",
    "api_key": "32-byte-hex-string-here",
    "staff_pin": "483921"
  },
  "cloud": {
    "base_url": "https://api.queue-manager.com",
    "ws_url": "wss://api.queue-manager.com/ws",
    "settings_channel": "settings:rest_a8f3k2"
  },
  "network": {
    "cashier_ip": "192.168.1.10",
    "printer_old_ip": "192.168.1.50",
    "printer_new_ip": "192.168.1.51",
    "printer_port": 9100,
    "interface_name": "Ethernet"
  },
  "extractor": {
    "rule_id": "rule_arabic_v1",
    "regex": "رقم الطلب:?\\s*(\\d+)"
  },
  "service": {
    "name": "QueueManager",
    "display_name": "Queue Manager Service",
    "recovery": {
      "first_failure_delay_sec": 5,
      "second_failure_delay_sec": 10,
      "third_failure_delay_sec": 20,
      "max_failures_in_period": 10,
      "failure_period_minutes": 30
    }
  },
  "local_server": {
    "websocket_port": 9200,
    "bind_address": "0.0.0.0"
  },
  "logging": {
    "level": "info",
    "max_file_size_mb": 50,
    "max_files": 7
  }
}
```

### ٤.٢ التحقق من صحة الإعدادات

`src/config/schema.js` يحتوي تحقق صارم من `config.json` عند بدء التشغيل. أي حقل ناقص أو خاطئ = البرنامج يفشل في البدء برسالة واضحة.

**الحقول الإلزامية:**
- `restaurant.id`
- `restaurant.api_key`
- `restaurant.staff_pin`
- `cloud.base_url`
- `cloud.ws_url`
- `network.cashier_ip`
- `network.printer_new_ip`
- `network.printer_port`
- `extractor.regex`
- `local_server.websocket_port`

### ٤.٣ تدفق التركيب الأولي

```
الفني يشغّل install.bat
          ↓
السكريبت يطلب: restaurant_id, api_key
          ↓
يجلب الإعدادات من السحابة (شامل staff_pin)
          ↓
يحفظها في config.json محلياً
          ↓
يثبّت البرنامج كـ Windows Service
          ↓
يبدأ التشغيل
```

التفاصيل الكاملة في PRD #7.

### ٤.٤ تحديث الإعدادات أثناء التشغيل

```
الأدمن يعدّل الإعدادات من لوحة التحكم
          ↓
السحابة تبعث: { type: "settings_updated" } عبر WebSocket
          ↓
البرنامج المحلي يطلب: GET /api/restaurants/{id}/config
          ↓
يكتب config.json الجديد
          ↓
يعيد تحميل الإعدادات في الذاكرة
          ↓
يطبّق التغييرات
```

**ما يمكن تحديثه دون إعادة تشغيل:**
- `extractor.regex`
- `restaurant.staff_pin` ← **مهم:** عند تغييره، كل الموظفين المتصلين عبر WebSocket المحلي يُطرَدون فوراً
- `logging.level`
- `service.recovery`

**ما يحتاج إعادة تشغيل:**
- `network.*`
- `local_server.websocket_port`

في حالة الحقول التي تحتاج إعادة تشغيل: يُكتَب الجديد، يُسجَّل warn، يستمر بالقديم.

---

## ٥. طبقة التخزين المحلي

### ٥.١ JSON Lines Store

`src/storage/jsonl-store.js`:

```javascript
class JsonlStore {
  constructor(filePath) { ... }
  async append(record) { ... }
  async readAll() { ... }
  async readWhere(predicate) { ... }
  async rewrite(records) { ... }
  async count() { ... }
}
```

### ٥.٢ الملفات المعتمدة

| اسم الملف | الغرض | يُملأ في |
|-----------|-------|---------|
| `active_orders.jsonl` | الطلبات النشطة | PRD #2 |
| `sync_queue.jsonl` | بانتظار المزامنة | PRD #2 |

### ٥.٣ قيود التصميم

- Append-only افتراضياً
- Rewrite عند التنظيف الدوري
- لا قفل (single process)
- حجم متوقع < 1 ميجا/يوم

---

## ٦. طبقة التسجيل (Logging)

### ٦.١ الواجهة

```javascript
const logger = require('./logging/logger')

logger.info('بدء التشغيل')
logger.warn('فشل المحاولة الأولى')
logger.error('فشل العملية', { details: '...' })
logger.critical('توقف نهائي')
```

### ٦.٢ المستويات والوجهات

| المستوى | الاستخدام |
|---------|----------|
| `debug` | تفاصيل تشخيصية |
| `info` | الأحداث العادية |
| `warn` | محاولات قابلة للتعافي |
| `error` | فشل في عملية |
| `critical` | فشل يهدد الاستمرار |

كل log يُكتَب في:
١. ملف محلي (`<getLogDir()>/queue-manager-YYYY-MM-DD.log`، تدوير يومي، احتفاظ 7 أيام)
٢. Console
٣. سجل النظام (لـ critical فقط)

### ٦.٣ الصيغة

```
2026-05-04T10:23:45.123Z [INFO] (interceptor) طلب جديد رقم 47، حجم 512 bytes
2026-05-04T10:23:45.125Z [INFO] (interceptor) تم التمرير في 1.8ms
2026-05-04T10:23:50.000Z [INFO] (ws-server) موظف اتصل من 192.168.1.20
2026-05-04T10:24:10.000Z [WARN] (sync) فشل الاتصال بالسحابة
```

---

## ٧. طبقة الفحص الذاتي (Health Check)

### ٧.١ متى تعمل

عند بدء التشغيل، **بعد تحميل الإعدادات وقبل بدء استقبال الطلبات.**

### ٧.٢ الفحوصات المطلوبة

| الفحص | إذا فشل |
|-------|---------|
| `config.json` صحيح | لا يبدأ، critical log، يخرج |
| المسارات قابلة للكتابة | يحاول الإنشاء، إذا فشل ينتهي |
| ملفات JSONL قابلة للقراءة | إنشاء فاضية |
| الاتصال بالسحابة | warn، يكمل |
| الاتصال بالطابعة | warn، يكمل |
| **بورت WebSocket المحلي متاح** | error، يخرج |

### ٧.٣ النتيجة

```
═══════════════════════════════════════════════
Queue Manager - بدء التشغيل
═══════════════════════════════════════════════
✓ ملف الإعدادات: صحيح
✓ مجلد البيانات: C:\ProgramData\QueueManager\data\
✓ ملفات التخزين: 12 طلب نشط
✓ السحابة: متصل
⚠ الطابعة: غير متصل
✓ بورت WebSocket المحلي 9200: متاح
═══════════════════════════════════════════════
الخدمة جاهزة. تستمع على:
  - 0.0.0.0:9100 (طلبات الكاشير)
  - 0.0.0.0:9200 (WebSocket للموظف)
LAN IP المُعلَن للسحابة: 192.168.1.5
═══════════════════════════════════════════════
```

---

## ٨. نقطة الدخول (`src/index.js`)

### ٨.١ التسلسل

```javascript
async function main() {
  try {
    const config = await loadConfig()
    initLogger(config.logging)
    const platform = require('./platform')
    await runHealthChecks(config, platform)
    
    const ordersStore = new JsonlStore(...)
    const syncQueue = new JsonlStore(...)
    
    // ستُملأ في PRD #2:
    // - Interceptor
    // - Cloud Sync Client (يبلّغ السحابة بـ LAN IP)
    // - Local WebSocket Server للموظف
    // - Settings Listener
    
    logger.info('Queue Manager جاهز')
  } catch (err) {
    logger.critical('فشل بدء التشغيل', { error: err.message })
    platform.logSystemEvent('critical', err.message)
    process.exit(1)
  }
}
```

### ٨.٢ Graceful Shutdown

عند `SIGTERM` / `SIGINT`:
١. توقف عن قبول طلبات جديدة
٢. إنهاء الطلبات الجارية
٣. إغلاق WebSocket connections مع الموظفين والسحابة
٤. حفظ الحالة في JSONL
٥. كتابة info log
٦. الخروج بـ exit code 0

---

## ٩. التقنيات والمكتبات

### ٩.١ المعتمدة

- **Node.js v20 LTS** أو أحدث
- **JavaScript** (ليس TypeScript للنسخة 1.0)
- المكتبات:
  - `ws` — WebSocket (للخادم المحلي وللاتصال مع السحابة)
  - `pino` — Logging
  - `iconv-lite` — فك ترميزات النص العربي
  - `node-windows` أو `nssm` — لتثبيت الخدمة

### ٩.٢ المرفوضة

- TypeScript (يضيف build step، نؤجله)
- better-sqlite3 (يحتاج C++ build)
- Express/Fastify (لا نحتاج HTTP server محلي، WebSocket كافي)

---

## ١٠. معايير القبول

- [ ] بنية المجلدات مطابقة للقسم ٢
- [ ] `src/platform/interface.js` يعرّف كل الدوال (شاملة `getLocalIpAddresses`)
- [ ] `src/platform/windows/adapter.js` يطبّق الواجهة هيكلياً
- [ ] `src/platform/linux/README.md` موجود
- [ ] `config.json` بـ schema صحيح في `config/config.example.json` (شامل `staff_pin`)
- [ ] البرنامج يبدأ بـ `node src/index.js`
- [ ] الفحص الذاتي يعمل (شامل فحص بورت WebSocket المحلي)
- [ ] الـ logger يكتب في ملف وconsole
- [ ] `JsonlStore` يعمل
- [ ] إعادة التشغيل تستعيد الحالة
- [ ] Graceful shutdown يعمل
- [ ] الـ settings-listener يحدّث `config.json` (شامل `staff_pin`)
- [ ] `package.json` و `README.md` موجودان

---

## ١١. الجدول الزمني المتوقع

| اليوم | المهمة |
|------|--------|
| 1 | إعداد المشروع، `package.json`، بنية المجلدات |
| 2 | `PlatformAdapter` interface + Windows skeleton (شامل `getLocalIpAddresses`) |
| 3 | `config/loader.js` + `schema.js` + `updater.js` (شامل `staff_pin`) |
| 4 | `JsonlStore` + اختبارات |
| 5 | `logger` + `health checker` + `index.js` |
| 6 | اختبار شامل + `README.md` |

**الإجمالي: 6 أيام عمل تقريبية.**

---

## ١٢. اعتبارات للـ PRDs اللاحقة

### ١٢.١ ما يحتاجه PRD #2 من هذا الـ PRD

- `JsonlStore` للقراءة والكتابة
- `platform.setupPrintInterception()`
- `platform.getLocalIpAddresses()` لإبلاغ السحابة
- `logger`
- `config.network.*`
- `config.local_server.*` لخادم WebSocket للموظف
- `config.restaurant.staff_pin` للتحقق من اتصالات الموظف

### ١٢.٢ ما يحتاجه PRD #3 من هذا الـ PRD

- صيغة `restaurant_id` و `api_key`
- صيغة WebSocket message للـ `settings_updated`
- معرفة أن `staff_pin` جزء من config وقابل للتحديث

### ١٢.٣ ما يحتاجه PRD #5 من هذا الـ PRD

- معرفة أن البرنامج المحلي عنده WebSocket على `local_server.websocket_port`
- صيغة المصادقة بـ PIN (نفسها على المحلي والسحابي)

---

**نهاية PRD #1 (النسخة 1.1).**
