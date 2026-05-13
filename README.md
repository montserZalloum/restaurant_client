# Queue Manager — Local Agent

نظام إدارة طوابير المطاعم. هذا المستودع يحتوي على البرنامج المحلي (Local Agent) الذي يعمل كـ Windows Service داخل المطعم.

## المتطلبات

- **Node.js 20 LTS** أو أحدث
- **Windows 10/11** (Linux محجوز للمستقبل — انظر `src/platform/linux/README.md`)

## التشغيل السريع (للاختبار)

```bash
# 1. ثبّت الاعتماديات
npm install

# 2. انسخ الإعدادات النموذجية
cp config/config.example.json config/config.json

# 3. عدّل config/config.json بقيم بيئتك (IP الكاشير، IP الطابعة، إلخ)

# 4. شغّل
npm start

# أو بصياغة قابلة للقراءة في Console
npm run start:pretty

# لوضع الاختبار (يستقبل الطباعة بدون تمريرها للطابعة، صفحة تشخيص على :9300)
npm run test-mode
```

## التركيب الإنتاجي

السكربت `scripts/install.bat` يُجري التركيب الكامل (تثبيت الخدمة، إعداد Firewall، تطبيق IP alias، جلب الإعدادات من السحابة). التفاصيل في `docs/PRD_07_installation.md`.

## بيئة التطوير (Mac كسحابة + Windows كمطعم)

الإعداد الكامل لبيئة التطوير في `docs/PRD_09_dev_environment.md`. الجزء المتعلّق بهذا المستودع (الويندوز):

```bash
# 1. انسخ نموذج الـ dev config
copy config\config.dev.example.json config\config.dev.json

# 2. عدّل config.dev.json — استبدل 192.168.1.50 بالـ IP الفعلي للماك على شبكتك
#    (على الماك:  ipconfig getifaddr en0)

# 3. وجّه الـ agent لهذا الـ config عبر متغيّر البيئة
set QM_CONFIG_FILE=%CD%\config\config.dev.json

# 4. تأكّد أن السحابة على الماك وصول من الويندوز قبل تشغيل الـ agent
npm run check-cloud

# 5. شغّل في وضع التطوير (يعيد التشغيل تلقائياً عند تعديل الكود)
npm run dev
```

`config/config.dev.json` و أي ملف `.env` خاص ببيئتك يجب ألا يُرفع للـ Git.

## بنية المشروع

```
src/
├── core/           ← المنطق الجوهري (مستقل عن نظام التشغيل)
├── server/         ← HTTP + WebSocket محلي للموظفين (PRD #8)
├── platform/       ← الطبقة المعتمدة على نظام التشغيل
├── storage/        ← JSONL persistence
├── config/         ← Loader + Validator + Updater
├── logging/        ← Logger
├── health/         ← Health checks
└── index.js        ← نقطة الدخول
```

## المرجعيات

| المستند | الموضوع |
|---|---|
| `docs/PRD_01_architecture_and_config.md` | البنية والإعدادات |
| `docs/PRD_02_local_agent.md` | منطق الاعتراض والاستخراج والمزامنة |
| `docs/PRD_03_cloud_backend.md` | السحابة |
| `docs/PRD_04_display_page.md` | شاشة العرض |
| `docs/PRD_05_staff_page.md` | صفحة الموظف |
| `docs/PRD_06_admin_panel.md` | لوحة التحكم |
| `docs/PRD_07_installation.md` | التركيب |
| `docs/PRD_08_amendments.md` | **التعديلات والتوضيحات (أولوية أعلى من باقي الـ PRDs)** |

## الترخيص

ملكية خاصة (UNLICENSED). جميع الحقوق محفوظة.
