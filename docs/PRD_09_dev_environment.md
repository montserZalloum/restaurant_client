# PRD #9: إعداد بيئة التطوير (الماك + الويندوز على نفس الشبكة)

> **الغرض:** دليل عملي خطوة بخطوة لتجهيز بيئة تطوير كاملة. الماك يلعب دور السحابة، والويندوز يلعب دور جهاز المطعم. الجهازان متصلان بنفس شبكة الواي فاي.

> **هذا ليس PRD تصميم،** هذا دليل تنفيذي. اتبع الخطوات بالترتيب.

> **مدة الإعداد المتوقعة:** 1-2 ساعة (بدون عجلة، مع التحقق من كل خطوة).

---

## ١. نظرة شاملة على البيئة

```
┌─────────────────────────┐         ┌──────────────────────────┐
│         الماك            │         │        الويندوز           │
│   (دور السحابة)         │◄───────►│      (دور المطعم)        │
│                         │  واي فاي │                          │
│  - PostgreSQL           │         │  - Node.js               │
│  - Cloud Backend        │         │  - Local Agent           │
│  - Display Page         │         │  - (لاحقاً) محاكي طابعة │
│  - Staff Page           │         │                          │
│                         │         │                          │
│  IP: 192.168.1.50       │         │  IP: 192.168.1.51        │
│  (مثال — لكل جهاز IP    │         │                          │
│   مختلف)                │         │                          │
└─────────────────────────┘         └──────────────────────────┘
```

**الفكرة:**
- الماك يشغّل السحابة محلياً (PostgreSQL + Backend + Pages)
- الويندوز يشغّل البرنامج المحلي
- الويندوز يتصل بالماك عبر الـ IP المحلي بدلاً من URL سحابي
- لما تجهز للإطلاق، تنقل كود السحابة لخدمة استضافة حقيقية بدون تعديل

---

## ٢. الجزء الأول: تجهيز الماك

### ٢.١ التحقق من macOS

افتح Terminal (Spotlight ⌘+Space → اكتب Terminal):

```bash
sw_vers
```

**النتيجة المتوقعة:** `ProductVersion: 13.x` أو أحدث (macOS Ventura فما فوق).

### ٢.٢ تثبيت Homebrew (مدير الحزم)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**يأخذ:** 5-15 دقيقة.

**التحقق:**
```bash
brew --version
# يجب أن يعرض: Homebrew 4.x.x
```

**إذا فشل:** قد تحتاج تثبيت Xcode Command Line Tools أولاً:
```bash
xcode-select --install
```

### ٢.٣ تثبيت Node.js v20

```bash
brew install node@20
```

ثم اربطه:
```bash
brew link node@20
```

**التحقق:**
```bash
node --version    # v20.x.x
npm --version     # 10.x.x
```

### ٢.٤ تثبيت PostgreSQL 16

```bash
brew install postgresql@16
```

**شغّل الخدمة:**
```bash
brew services start postgresql@16
```

**أضفه للـ PATH** (إذا لم يكن مضافاً):
```bash
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**التحقق:**
```bash
psql --version          # postgres 16.x
psql -l                 # قائمة قواعد البيانات
```

### ٢.٥ إنشاء قاعدة البيانات

```bash
createdb queue_manager_dev
```

**التحقق:**
```bash
psql queue_manager_dev -c "SELECT 'connected';"
# يجب أن يعرض: connected
```

اخرج بـ `\q`.

### ٢.٦ تثبيت Git

```bash
brew install git
git --version    # git version 2.x.x
```

**إعداد Git أول مرة (لو ما عملته قبل):**
```bash
git config --global user.name "اسمك"
git config --global user.email "your-email@example.com"
```

### ٢.٧ تثبيت VS Code

من https://code.visualstudio.com/ — تنزيل وفتح.

أو عبر Homebrew:
```bash
brew install --cask visual-studio-code
```

**Extensions مفيدة (تثبّتها من داخل VS Code):**
- ESLint
- Prettier
- Prisma (للـ ORM)
- DotENV
- Arabic Language Pack (اختياري)

### ٢.٨ معرفة IP الماك على الشبكة

**هذي خطوة حرجة.** الويندوز سيتصل بهذا الـ IP.

```bash
ipconfig getifaddr en0
```

**النتيجة المتوقعة:** `192.168.1.50` أو ما شابه.

**ملاحظات:**
- `en0` عادةً للواي فاي
- لو الأمر فاضي، جرّب `en1`:
  ```bash
  ipconfig getifaddr en1
  ```
- لو الكيبل Ethernet، قد يكون `en2`

**اكتب هذا الـ IP في ورقة. سنحتاجه لاحقاً.**

افترض في باقي هذا الدليل أن IP الماك = `192.168.1.50`. **استبدله بالـ IP الفعلي عندك.**

### ٢.٩ السماح بالاتصالات الواردة في Mac Firewall

افتح System Settings → Network → Firewall.

إذا كان الـ Firewall **مغلق**: اتركه (الأبسط للتطوير).

إذا كان **مفتوح**:
- اضغط "Options"
- أضف Node.js للقائمة المسموح بها (سنفعل هذا لما نشغّل السرفر أول مرة، النظام سيسأل تلقائياً)

---

## ٣. الجزء الثاني: تجهيز الويندوز

### ٣.١ تثبيت Node.js v20

من https://nodejs.org/en/download/ — اختر "Windows Installer (.msi)" 64-bit.

ثبّته بالإعدادات الافتراضية، شغّل "next" حتى النهاية.

**التحقق (افتح Command Prompt جديد بعد التثبيت):**
```cmd
node --version
npm --version
```

### ٣.٢ تثبيت Git

من https://git-scm.com/download/win — حمّل وثبّته بالإعدادات الافتراضية.

**التحقق:**
```cmd
git --version
```

### ٣.٣ تثبيت VS Code (اختياري على الويندوز)

من https://code.visualstudio.com/ — قد تفضّل التطوير من الماك والاتصال للويندوز عبر SSH أو AnyDesk، أو فتح VS Code على الويندوز مباشرة.

### ٣.٤ معرفة IP الويندوز

افتح Command Prompt:
```cmd
ipconfig
```

ابحث عن:
```
Ethernet adapter Wi-Fi:
   IPv4 Address. . . . . . . . . . . : 192.168.1.51
```

افترض IP الويندوز = `192.168.1.51`.

### ٣.٥ اختبار الاتصال بين الجهازين

**من الماك، اتصل بالويندوز:**
```bash
ping 192.168.1.51
```

اضغط Ctrl+C للإيقاف.

**النتيجة المتوقعة:** ردود `bytes from 192.168.1.51`.

**من الويندوز، اتصل بالماك:**
```cmd
ping 192.168.1.50
```

**إذا فشل أحد الاتصالين:**
- الجهازان على نفس شبكة الواي فاي؟
- Mac Firewall يحجب الـ ping؟ (قد يحجب افتراضياً، تجاوز هذا للوقت الحالي)
- بعض شبكات الواي فاي تمنع الأجهزة من رؤية بعضها (Client Isolation) — جرّب شبكة منزلية بسيطة

---

## ٤. الجزء الثالث: بنية المشروع

### ٤.١ على الماك — أنشئ المشروع

```bash
mkdir ~/Development
cd ~/Development
mkdir queue-manager
cd queue-manager
```

أنشئ الـ Git repo:
```bash
git init
```

### ٤.٢ بنية المجلدات الرئيسية

```bash
mkdir cloud agent display staff
```

البنية المتوقعة:
```
queue-manager/
├── cloud/        ← Backend السحابة (يشتغل على الماك في التطوير)
├── agent/        ← البرنامج المحلي (يشتغل على الويندوز)
├── display/      ← صفحة الشاشة (تُخدَم من cloud)
└── staff/        ← صفحة الموظف (تُخدَم من cloud وlocal)
```

### ٤.٣ ملف .gitignore الرئيسي

أنشئ ملف `.gitignore` في الجذر:

```bash
cat > .gitignore <<EOF
node_modules/
.env
.env.local
*.log
.DS_Store
dist/
build/
*.tsbuildinfo
.vscode/
EOF
```

### ٤.٤ README أولي

```bash
cat > README.md <<EOF
# Queue Manager

نظام إدارة طابور المطاعم.

## التطوير

- \`cloud/\` — Backend (يشتغل على Mac أثناء التطوير)
- \`agent/\` — البرنامج المحلي (يشتغل على Windows)
- \`display/\` — صفحة الشاشة
- \`staff/\` — صفحة الموظف

راجع \`PRD_09_dev_environment.md\` للإعداد.
EOF
```

### ٤.٥ Commit أولي

```bash
git add .
git commit -m "Initial project structure"
```

---

## ٥. الجزء الرابع: تجهيز السحابة على الماك

### ٥.١ الانتقال للمجلد

```bash
cd ~/Development/queue-manager/cloud
```

### ٥.٢ إعداد Node.js project

```bash
npm init -y
```

عدّل `package.json` ليصير:

```json
{
  "name": "queue-manager-cloud",
  "version": "0.1.0",
  "description": "Queue Manager Cloud Backend",
  "main": "src/index.js",
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js"
  },
  "type": "commonjs"
}
```

### ٥.٣ تثبيت التبعيات الأساسية

```bash
npm install fastify @fastify/websocket @fastify/static @fastify/cors
npm install pg pino pino-pretty dotenv
npm install --save-dev nodemon
```

(لاحقاً نضيف Prisma، لكن نبدأ بسيط أولاً.)

### ٥.٤ ملف .env للسحابة

```bash
cat > .env <<EOF
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgresql://localhost:5432/queue_manager_dev
LOG_LEVEL=debug
EOF
```

**ملاحظة:** `HOST=0.0.0.0` مهم — يخلي السرفر يقبل اتصالات من أي IP (مش بس localhost). هذا ضروري ليتصل به الويندوز.

### ٥.٥ بنية مجلدات السحابة

```bash
mkdir -p src/{routes,db,websocket,middleware,utils}
mkdir public
```

### ٥.٦ سرفر "Hello World" أساسي

أنشئ `src/index.js`:

```bash
cat > src/index.js <<'EOF'
require('dotenv').config()

const Fastify = require('fastify')

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
})

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: Date.now() }
})

// Hello world
fastify.get('/', async () => {
  return { message: 'Queue Manager Cloud is running' }
})

// Start
const start = async () => {
  try {
    await fastify.listen({
      port: process.env.PORT || 3000,
      host: process.env.HOST || '0.0.0.0'
    })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
EOF
```

### ٥.٧ شغّل السرفر

```bash
npm run dev
```

**النتيجة المتوقعة:**
```
Server listening at http://0.0.0.0:3000
```

**اختبر من المتصفح على الماك:**

افتح http://localhost:3000

ترى:
```json
{ "message": "Queue Manager Cloud is running" }
```

افتح http://localhost:3000/health

ترى:
```json
{ "status": "ok", "timestamp": ... }
```

### ٥.٨ اختبار من جهاز آخر على الشبكة

**من المتصفح على الويندوز:**

افتح: `http://192.168.1.50:3000` (ضع IP الماك الفعلي).

**يجب** أن ترى نفس النتيجة.

**إذا فشل:**
- Mac Firewall يحجب؟ → System Settings → Network → Firewall → اسمح لـ Node
- IP الماك صحيح؟ → ارجع للقسم ٢.٨
- الجهازان على نفس الشبكة؟

اترك السرفر شغّال. افتح Terminal جديد للأوامر القادمة.

---

## ٦. الجزء الخامس: تجهيز البرنامج المحلي على الويندوز

### ٦.١ نقل ملفات المشروع للويندوز

عندك خياران:

**أ. Git (الأنظف):** ادفع الكود من الماك لـ GitHub، اسحبه على الويندوز.

```bash
# على الماك
cd ~/Development/queue-manager
git remote add origin https://github.com/your-username/queue-manager.git
git push -u origin main
```

```cmd
:: على الويندوز
cd C:\Users\YourName\Development
git clone https://github.com/your-username/queue-manager.git
cd queue-manager
```

**ب. مشاركة شبكة (أبسط للبدء):** مشاركة المجلد عبر SMB من الماك ونسخه للويندوز.

**ج. USB drive:** أبسط في البداية إذا الجهازين قريبين.

اختر الأنسب لك.

### ٦.٢ تجهيز agent على الويندوز

```cmd
cd C:\Users\YourName\Development\queue-manager\agent
npm init -y
```

عدّل `package.json`:

```json
{
  "name": "queue-manager-agent",
  "version": "0.1.0",
  "main": "src/index.js",
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js"
  }
}
```

### ٦.٣ تثبيت تبعيات agent

```cmd
npm install ws axios pino pino-pretty dotenv iconv-lite
npm install --save-dev nodemon
```

### ٦.٤ ملف config أولي

أنشئ `agent/config.json`:

```json
{
  "version": 1,
  "restaurant": {
    "id": "rest_test01",
    "name": "Test Restaurant"
  },
  "cloud": {
    "url": "http://192.168.1.50:3000",
    "ws_url": "ws://192.168.1.50:3000/ws/local-agent",
    "api_key": "dev-key-not-secure"
  },
  "network": {
    "original_printer_ip": "192.168.1.88",
    "forwarded_printer_ip": "192.168.1.99",
    "listen_port": 9100
  },
  "local_server": {
    "port": 9200,
    "bind_address": "0.0.0.0"
  },
  "staff_pin": "123456",
  "logging": {
    "level": "debug",
    "directory": "./logs"
  }
}
```

**استبدل `192.168.1.50` بالـ IP الفعلي للماك.**

### ٦.٥ Hello World للـ agent

أنشئ `src/index.js`:

```javascript
const fs = require('fs')
const path = require('path')

// تحميل config
const configPath = path.join(__dirname, '..', 'config.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

console.log('=================================')
console.log('Queue Manager Agent (Dev)')
console.log('=================================')
console.log(`Restaurant: ${config.restaurant.name}`)
console.log(`Cloud URL: ${config.cloud.url}`)
console.log('---------------------------------')

// اختبار الاتصال بالسحابة (الماك)
const axios = require('axios')

async function testCloudConnection() {
  try {
    const response = await axios.get(`${config.cloud.url}/health`)
    console.log('✓ Cloud connection: OK')
    console.log('  Response:', response.data)
  } catch (err) {
    console.log('✗ Cloud connection: FAILED')
    console.log('  Error:', err.message)
    console.log('')
    console.log('تحقق من:')
    console.log('  1. السحابة شغّالة على الماك (npm run dev)')
    console.log('  2. IP الماك صحيح في config.json')
    console.log('  3. الجهازان على نفس الشبكة')
  }
}

testCloudConnection()
```

### ٦.٦ شغّل البرنامج المحلي

```cmd
cd C:\Users\YourName\Development\queue-manager\agent
npm run dev
```

**النتيجة المتوقعة:**
```
=================================
Queue Manager Agent (Dev)
=================================
Restaurant: Test Restaurant
Cloud URL: http://192.168.1.50:3000
---------------------------------
✓ Cloud connection: OK
  Response: { status: 'ok', timestamp: 1746345600000 }
```

**🎉 إذا شفت `✓ Cloud connection: OK`، البيئة جاهزة.**

---

## ٧. التحقق النهائي من البيئة

### ٧.١ الفحص الشامل

| العنصر | كيف تتحقق |
|--------|-----------|
| Node.js على الماك | `node --version` |
| PostgreSQL يعمل | `psql -l` يُرجِع القائمة |
| قاعدة البيانات موجودة | `psql queue_manager_dev` يدخل |
| السحابة تعمل على الماك | `curl http://localhost:3000/health` يُرجِع 200 |
| السحابة متاحة من الشبكة | `curl http://[mac-ip]:3000/health` من الويندوز |
| Node.js على الويندوز | `node --version` |
| الويندوز يصل للماك | البرنامج المحلي يطبع `Cloud connection: OK` |

### ٧.٢ سيناريو الاستخدام اليومي

**على الماك (نافذة Terminal واحدة):**
```bash
cd ~/Development/queue-manager/cloud
npm run dev
```
اتركها شغّالة طوال يوم العمل.

**على الويندوز (نافذة Command Prompt واحدة):**
```cmd
cd C:\Users\YourName\Development\queue-manager\agent
npm run dev
```
اتركها شغّالة طوال يوم العمل.

أي تعديل تعمله على الكود، nodemon يعيد التشغيل تلقائياً.

---

## ٨. الانتقال للسحابة الحقيقية لاحقاً

عند جاهزيتك للنشر (قبل زيارة المطعم بأسبوع):

### ٨.١ ما يتغيّر

- كود السحابة من الماك يُنشَر على Railway/DigitalOcean
- في `config.json` على الويندوز، تغيّر الـ URLs:
  ```json
  "cloud": {
    "url": "https://api.queue-manager.com",
    "ws_url": "wss://api.queue-manager.com/ws/local-agent"
  }
  ```
- باقي الكود **لا يتغيّر**

### ٨.٢ خطوات النشر (سنفصّلها لاحقاً)

1. اشتراك في Railway أو DigitalOcean
2. ربط الـ GitHub repo
3. إعداد PostgreSQL managed
4. إضافة environment variables
5. النشر

---

## ٩. حل المشاكل الشائعة

### ٩.١ "Cloud connection: FAILED" من الويندوز

**الفحص:**
1. السحابة شغّالة على الماك؟ (افحص Terminal الماك)
2. IP الماك في config صحيح؟ (`ipconfig getifaddr en0` على الماك)
3. الـ Firewall على الماك يحجب؟ (System Settings → Network → Firewall)
4. الجهازان على نفس الشبكة؟ (`ping` بين الجهازين)
5. الراوتر يفعّل Client Isolation؟ (إعدادات الراوتر)

### ٩.٢ "Cannot find module 'fastify'" أو ما شابه

```bash
# تأكد إنك في المجلد الصحيح
pwd    # على الماك
cd     # على الويندوز

# أعد التثبيت
npm install
```

### ٩.٣ "Port 3000 already in use"

شيء آخر يستخدم البورت. غيّر البورت في `.env`:
```
PORT=3001
```

أو أوقف العملية اللي تستخدمه:
```bash
# على الماك
lsof -i :3000
kill -9 [PID]
```

### ٩.٤ PostgreSQL ما يبدأ

```bash
brew services restart postgresql@16
```

لو ما زال فيه مشكلة:
```bash
brew services list
# تأكد إن postgresql@16 status: started
```

### ٩.٥ تغيّر IP الماك

كل مرة تتصل بشبكة جديدة، الـ IP قد يتغيّر:

1. افحص IP الجديد: `ipconfig getifaddr en0`
2. حدّث `agent/config.json` على الويندوز
3. أعد تشغيل البرنامج المحلي

**نصيحة لاحقاً:** اضبط IP ثابت للماك من إعدادات الراوتر (DHCP reservation).

---

## ١٠. الخطوات التالية

بيئة التطوير جاهزة. الآن:

١. **ابدأ PRD #3 (السحابة):** أضف قاعدة البيانات، الـ schemas، الـ endpoints الأساسية على الماك

٢. **ابدأ PRD #2 (البرنامج المحلي):** أضف TCP server، extractor، sync queue على الويندوز

٣. **اختبر التكامل:** أرسل event من البرنامج المحلي → الماك يستلم → يُحفَظ في DB

كل خطوة من هذي يمكن اختبارها فوراً بدون انتظار deployment لسحابة بعيدة. هذا أسرع تطوير ممكن.

---

## ١١. ملاحظات نهائية

### ١١.١ احفظ نقطة العمل الحالية

```bash
cd ~/Development/queue-manager
git add .
git commit -m "Dev environment setup complete"
```

### ١١.٢ أنشئ branches للميزات

```bash
git checkout -b feature/cloud-database
# تشتغل على هذا الـ branch
# لما تخلص:
git add .
git commit -m "Add database schema"
git checkout main
git merge feature/cloud-database
```

### ١١.٣ لا تخلط بين البيئات

- **dev:** الماك + الويندوز محلياً (الآن)
- **staging:** السحابة الحقيقية + جهاز اختبار (لاحقاً، قبل المطعم)
- **production:** السحابة + جهاز المطعم الفعلي (الإطلاق)

ميّز كل بيئة بـ `.env` مختلف.

---

**نهاية PRD #9.**

**تذكير:** هذا PRD إعداد، يُنفَّذ مرة واحدة. بعد الانتهاء، ابدأ PRD #3 على الماك و PRD #2 على الويندوز بالتوازي.
