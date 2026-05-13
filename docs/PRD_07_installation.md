# PRD #7: التثبيت والنشر (Installation & Deployment)

> **الغرض من هذا المستند:** تحديد كيفية تثبيت البرنامج المحلي على جهاز المطعم بطريقة موثوقة ومتكررة، وكيفية تشغيل النظام كاملاً (شاشة + موظف + سحابة) في أول يوم.

> **المرجعيات:**
> - PRD #1: قسم ٢ (PlatformAdapter)، قسم ٤ (config.json)، قسم ٧ (الخدمة)
> - PRD #2: قسم ٣ (TCP Server)، قسم ٩ (Local WebSocket)
> - PRD #6: قسم ٦.٢ (تنزيل config.json من اللوحة)

> **الجمهور:** الفنّي الذي ينفّذ التثبيت في المطعم (قد يكون صاحب المشروع نفسه في البداية، أو شخص بمعرفة تقنية متوسطة).

> **التبعيات:** PRD #2 مكتمل (البرنامج المحلي جاهز للنشر). PRD #6 مفيد لكن غير ضروري إذا كانت الإعدادات تُولَّد يدوياً.

---

## ١. النطاق

### ١.١ ما يشمله هذا الـ PRD

- متطلبات الجهاز والشبكة قبل التثبيت
- script التثبيت (`install.bat`) خطوة بخطوة
- إعداد البرنامج كـ Windows Service عبر NSSM
- آلية IP Aliasing (تحويل عنوان الطابعة)
- قواعد Firewall
- "Test Mode" لاختبار الاستخراج قبل التشغيل الفعلي
- دليل التركيب للفنّي
- إجراءات التحديث وإلغاء التثبيت
- استكشاف الأخطاء الشائعة

### ١.٢ ما هو خارج النطاق

- تطوير برنامج installer رسومي (`.msi` أو `setup.exe`) — مؤجَّل للنسخة 2.0
- توقيع الكود (Code Signing) — مؤجَّل
- التحديث التلقائي (auto-update) — مؤجَّل، النسخة 1.0 تُحدَّث يدوياً
- نشر السحابة (مفترض أنها مستضافة بالفعل، PRD #3 يغطّي ذلك)

### ١.٣ المبادئ الموجِّهة

- **التثبيت يجب أن يكون قابل للتكرار:** نفس الخطوات تعطي نفس النتيجة على أي جهاز
- **التثبيت يجب أن يكون قابل للعكس:** كل خطوة لها خطوة عكسية واضحة (uninstall)
- **الفنّي يجب ألا يحتاج معرفة عميقة بـ Node.js:** الـ script يعتني بالتفاصيل
- **الفشل يجب أن يكون واضحاً:** رسائل خطأ مفهومة وقابلة للتشخيص

---

## ٢. المتطلبات المسبقة

### ٢.١ متطلبات الجهاز

- Windows 10 أو Windows 11 (64-bit)
- 2 GB RAM (حد أدنى)
- 500 MB مساحة قرص فاضية
- صلاحيات Administrator على الجهاز
- اتصال إنترنت لتنزيل التحديثات والاتصال بالسحابة

### ٢.٢ متطلبات الشبكة

- الجهاز والطابعة على **نفس الشبكة المحلية**
- IP ثابت أو DHCP reservation للجهاز (مهم لـ IP Aliasing)
- IP ثابت للطابعة الحرارية (موصى به)
- لا قيود firewall على الشبكة الداخلية تمنع TCP بين الكاشير والجهاز
- اتصال خارج للسحابة على البورت 443 (HTTPS/WSS)

### ٢.٣ معلومات يجب جمعها قبل التثبيت

| المعلومة | كيف تحصل عليها |
|----------|----------------|
| IP الطابعة الحالي | إعدادات برنامج الكاشير، أو طباعة Self-test من الطابعة |
| IP الجهاز | `ipconfig` على Windows |
| Subnet Mask | `ipconfig` |
| Gateway | `ipconfig` |
| Network Interface name | `netsh interface show interface` |
| نوع برنامج الكاشير | سؤال صاحب المطعم |
| نموذج الطابعة | عينياً |

---

## ٣. مكوّنات حزمة التثبيت

### ٣.١ ما يصل لجهاز المطعم

```
queue-manager-installer/
├── install.bat                  ← script التثبيت الرئيسي
├── uninstall.bat                ← script إلغاء التثبيت
├── test-mode.bat                ← script لتشغيل وضع الاختبار
├── nssm.exe                     ← أداة إدارة Windows Services
├── node-v20.x.x-win-x64/        ← Node.js portable (لتجنّب التعارض مع نسخ موجودة)
├── agent/                       ← كود البرنامج المحلي
│   ├── package.json
│   ├── node_modules/            ← مُثبَّتة مسبقاً
│   ├── src/
│   └── ...
├── config.json                  ← الإعدادات (من اللوحة السحابية)
├── README.txt                   ← دليل سريع للفنّي
└── INSTALL_GUIDE.pdf            ← دليل التركيب الكامل
```

**الحجم المتوقع:** 80-120 MB (معظمه Node.js + node_modules).

**التوزيع:**
- ZIP file يُرسَل للفنّي
- أو USB stick
- أو تنزيل من رابط آمن (https://...)

### ٣.٢ Node.js Portable vs System Install

**القرار: استخدام Node.js Portable مع البرنامج.**

**السبب:**
- يضمن نسخة محددة من Node.js بدون تعارض
- المطعم قد يكون عنده نسخة قديمة لتطبيق آخر
- لا يحتاج installer منفصل لـ Node.js
- إلغاء التثبيت أنظف (مجلد واحد للحذف)

**العنوان:** Node.js v20.x.x portable من https://nodejs.org/dist/

---

## ٤. سكربت التثبيت `install.bat`

### ٤.١ الهيكل العام

```batch
@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   Queue Manager - Installation
echo ============================================
echo.

:: 1. التحقق من صلاحيات Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    pause
    exit /b 1
)

:: 2. التحقق من وجود config.json
if not exist "config.json" (
    echo ERROR: config.json not found. Please place it next to install.bat.
    pause
    exit /b 1
)

:: 3. قراءة الإعدادات من config.json
:: (نستخدم Node.js المُرفَق لقراءة الإعدادات بأمان)

:: 4. التأكيد على المسار
set INSTALL_DIR=C:\ProgramData\QueueManager
echo Installing to: %INSTALL_DIR%
echo.
set /p CONFIRM="Continue? (y/n): "
if /i not "%CONFIRM%"=="y" exit /b 0

:: 5. إنشاء المجلدات
mkdir "%INSTALL_DIR%" 2>nul
mkdir "%INSTALL_DIR%\agent" 2>nul
mkdir "%INSTALL_DIR%\node" 2>nul
mkdir "%INSTALL_DIR%\config" 2>nul
mkdir "%INSTALL_DIR%\logs" 2>nul
mkdir "%INSTALL_DIR%\data" 2>nul

:: 6. نسخ الملفات
echo Copying files...
xcopy /E /I /Y "agent" "%INSTALL_DIR%\agent" >nul
xcopy /E /I /Y "node-v20.x.x-win-x64" "%INSTALL_DIR%\node" >nul
copy /Y "config.json" "%INSTALL_DIR%\config\config.json" >nul
copy /Y "nssm.exe" "%INSTALL_DIR%\nssm.exe" >nul

:: 7. إعداد IP Alias
echo Setting up IP alias...
call :SETUP_IP_ALIAS
if !errorlevel! neq 0 goto :ERROR

:: 8. إعداد Firewall
echo Setting up Firewall rules...
call :SETUP_FIREWALL
if !errorlevel! neq 0 goto :ERROR

:: 9. تثبيت Windows Service
echo Installing Windows Service...
call :INSTALL_SERVICE
if !errorlevel! neq 0 goto :ERROR

:: 10. تشغيل الخدمة
echo Starting service...
net start QueueManagerAgent
if !errorlevel! neq 0 goto :ERROR

:: 11. التحقق من الاتصال
echo Verifying connection...
timeout /t 5 /nobreak >nul
:: (سكربت يستدعي Node.js للتحقق من اتصال السحابة)

echo.
echo ============================================
echo   Installation completed successfully!
echo ============================================
echo.
echo Next steps:
echo   1. Reconfigure printer to new IP
echo   2. Send test print from cashier
echo   3. Open display page on TV
echo   4. Open staff page on phone
echo.
pause
exit /b 0

:ERROR
echo.
echo ERROR: Installation failed. Check logs at:
echo   %INSTALL_DIR%\logs\install.log
pause
exit /b 1
```

### ٤.٢ خطوات تفصيلية

#### ٤.٢.١ التحقق من Administrator

```batch
net session >nul 2>&1
```

إذا لم يكن المستخدم admin، الـ script يخرج برسالة واضحة.

#### ٤.٢.٢ التحقق من config.json وقراءته

```batch
:: استخدام Node.js لقراءة JSON بأمان
for /f "delims=" %%a in ('node -e "console.log(JSON.parse(require('fs').readFileSync('config.json'))?.network?.original_printer_ip || '')"') do set ORIGINAL_IP=%%a

if "%ORIGINAL_IP%"=="" (
    echo ERROR: config.json is missing network.original_printer_ip
    exit /b 1
)
```

#### ٤.٢.٣ تأكيد المستخدم

عرض ملخص ما سيحدث، طلب تأكيد:

```
==========================================
  Queue Manager - About to install
==========================================
Restaurant: مطعم الشرق
Restaurant ID: rest_a8f3k2
Original Printer IP: 192.168.1.88
Forwarded Printer IP: 192.168.1.99
Agent will listen on: 192.168.1.88:9100

Continue? (y/n):
```

#### ٤.٢.٤ نسخ الملفات

المجلد الافتراضي: `C:\ProgramData\QueueManager`

**سبب اختيار `ProgramData`:**
- لا يحتاج صلاحيات admin للقراءة (مقارنة بـ `Program Files`)
- مكان مناسب للبيانات المتغيرة (logs, data)
- معروف ومُتعارَف عليه

#### ٤.٢.٥ Setup IP Alias (راجع قسم ٥)

#### ٤.٢.٦ Setup Firewall (راجع قسم ٦)

#### ٤.٢.٧ تثبيت Service (راجع قسم ٧)

---

## ٥. IP Aliasing — الجزء الحرج

### ٥.١ الفكرة

برنامج الكاشير معتاد على إرسال الطباعة إلى IP محدد (مثلاً `192.168.1.88`). نريد أن نعترض هذه الطباعة بدون تعديل برنامج الكاشير.

**الحل:**
1. الطابعة الحقيقية تُنقَل لعنوان جديد (مثلاً `192.168.1.99`)
2. جهازنا (اللاب توب أو الـ mini PC) يأخذ العنوان القديم (`192.168.1.88`) بالإضافة لعنوانه الأصلي
3. كاشير يرسل لـ `192.168.1.88` → يصل لجهازنا → نعترض → نمرّر لـ `192.168.1.99`

### ٥.٢ على Windows: `netsh`

```batch
:: إضافة IP alias إلى Network Interface
netsh interface ip add address "Ethernet" 192.168.1.88 255.255.255.0
```

**ملاحظات:**
- `"Ethernet"` هو اسم الـ network interface (قد يكون `"Wi-Fi"` أو غيره)
- يجب اكتشاف الاسم الصحيح قبل الإضافة
- العنوان الـ subnet mask يجب أن يطابق الشبكة

### ٥.٣ اكتشاف اسم Network Interface

```batch
for /f "tokens=4*" %%a in ('netsh interface show interface ^| findstr /i "Connected"') do (
    set INTERFACE_NAME=%%a %%b
    goto :FOUND_INTERFACE
)
:FOUND_INTERFACE
```

أو السماح للفنّي باختيار الـ interface يدوياً من قائمة.

**الأفضل:** الـ `config.json` يحدد الـ interface، وإذا كان `auto`، الـ script يكتشفه.

### ٥.٤ إعادة إعداد الطابعة

**هذه الخطوة لا تُؤتمَت عبر script.** الفنّي يحتاج:

١. الوصول لإعدادات الطابعة (عادةً عبر زر على الطابعة + طباعة Self-test)
٢. تغيير IP الطابعة من `192.168.1.88` إلى `192.168.1.99`
٣. تأكيد التغيير (طباعة Self-test جديدة)

**مهم:** هذه الخطوة تتم **قبل** تشغيل الـ install.bat. السبب: لو غيّرنا IP الجهاز قبل تغيير IP الطابعة، يحدث IP conflict.

### ٥.٥ الترتيب الصحيح للخطوات

```
الترتيب:
1. غيّر IP الطابعة الحقيقية (192.168.1.88 → 192.168.1.99) ← الفنّي يدوياً
2. تأكد أن الطابعة تعمل على العنوان الجديد ← اختبار طباعة
3. شغّل install.bat على جهاز Queue Manager ← الـ script يضيف 192.168.1.88 alias
4. اختبر إرسال طباعة من الكاشير ← يجب أن يصل للجهاز ويُمرَّر للطابعة
```

### ٥.٦ إزالة IP Alias

عند إلغاء التثبيت:

```batch
netsh interface ip delete address "Ethernet" 192.168.1.88
```

### ٥.٧ ملاحظة على البقاء عبر الـ Reboot

`netsh interface ip add address` يضيف العنوان بشكل **دائم** افتراضياً (يبقى بعد الـ reboot).

**اختبار مطلوب:** التحقق من بقاء الـ alias بعد إعادة تشغيل الجهاز. على بعض إصدارات Windows، قد يحتاج إعادة تطبيق.

**خطة احتياطية:** الـ Windows Service عند بدء التشغيل يتحقق من وجود الـ alias، ويعيد إضافته لو فُقد.

---

## ٦. قواعد Firewall

### ٦.١ المنافذ المطلوبة

| المنفذ | الاتجاه | الغرض |
|-------|---------|--------|
| 9100 TCP | Inbound | استقبال الطباعة من الكاشير |
| 9200 TCP | Inbound | WebSocket محلي للموظف |
| 443 TCP | Outbound | الاتصال بالسحابة (HTTPS/WSS) |

### ٦.٢ إضافة القواعد

```batch
:: السماح بـ Inbound على بورت 9100 (الطباعة)
netsh advfirewall firewall add rule ^
    name="Queue Manager - Print Receiver" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=9100

:: السماح بـ Inbound على بورت 9200 (WebSocket محلي)
netsh advfirewall firewall add rule ^
    name="Queue Manager - Local WebSocket" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=9200

:: Outbound عادةً مسموح بشكل افتراضي، لكن نضيف صريحاً للتوثيق
netsh advfirewall firewall add rule ^
    name="Queue Manager - Cloud Connection" ^
    dir=out ^
    action=allow ^
    protocol=TCP ^
    remoteport=443
```

### ٦.٣ النطاق

القواعد تُطبَّق على **Private network profile** فقط (الشبكات الموثوقة).

```batch
netsh advfirewall firewall add rule ^
    name="..." ^
    profile=private
```

**مهم:** الـ Public network profile لا يُسمَح بالاتصال — حماية إضافية لو الجهاز متصل بشبكة عامة.

### ٦.٤ إزالة القواعد

```batch
netsh advfirewall firewall delete rule name="Queue Manager - Print Receiver"
netsh advfirewall firewall delete rule name="Queue Manager - Local WebSocket"
netsh advfirewall firewall delete rule name="Queue Manager - Cloud Connection"
```

---

## ٧. Windows Service via NSSM

### ٧.١ ما هو NSSM؟

**NSSM** (Non-Sucking Service Manager) أداة مفتوحة المصدر تحوّل أي executable إلى Windows Service.

السبب لاستخدامها بدلاً من `sc.exe`:
- أبسط في الإعداد
- يعالج إعادة التشغيل تلقائياً
- يدير stdout/stderr في log files
- معروفة وموثوقة

### ٧.٢ التثبيت

```batch
:: تثبيت الخدمة
"%INSTALL_DIR%\nssm.exe" install QueueManagerAgent ^
    "%INSTALL_DIR%\node\node.exe" ^
    "%INSTALL_DIR%\agent\src\index.js"

:: تحديد المجلد العامل (working directory)
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent AppDirectory "%INSTALL_DIR%\agent"

:: متغير بيئي للإعدادات
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent AppEnvironmentExtra ^
    CONFIG_PATH="%INSTALL_DIR%\config\config.json" ^
    DATA_DIR="%INSTALL_DIR%\data" ^
    LOG_DIR="%INSTALL_DIR%\logs"

:: إعداد logs
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent AppStdout "%INSTALL_DIR%\logs\stdout.log"
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent AppStderr "%INSTALL_DIR%\logs\stderr.log"

:: إعادة التشغيل التلقائي عند الفشل
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent AppRestartDelay 5000
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent AppExit Default Restart

:: Start automatically on boot
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent Start SERVICE_AUTO_START

:: الوصف
"%INSTALL_DIR%\nssm.exe" set QueueManagerAgent Description ^
    "Queue Manager Local Agent - Intercepts print jobs and forwards them"
```

### ٧.٣ تشغيل الخدمة

```batch
net start QueueManagerAgent
```

### ٧.٤ التحقق من الحالة

```batch
sc query QueueManagerAgent
```

### ٧.٥ إلغاء التثبيت

```batch
net stop QueueManagerAgent
"%INSTALL_DIR%\nssm.exe" remove QueueManagerAgent confirm
```

### ٧.٦ الـ Logs

NSSM يكتب stdout/stderr إلى ملفات:
- `%INSTALL_DIR%\logs\stdout.log`
- `%INSTALL_DIR%\logs\stderr.log`

البرنامج نفسه يكتب logs منظّمة إلى:
- `%INSTALL_DIR%\logs\agent.log` (JSON lines)

(راجع PRD #1 قسم ٦.٢ لتفاصيل الـ logging)

---

## ٨. Test Mode (وضع الاختبار)

### ٨.١ الغرض

بعد التثبيت، الفنّي يحتاج التأكد من:
1. الجهاز يستقبل الطباعة (الكاشير يرسل بنجاح)
2. الـ extractor يستخرج الرقم الصحيح
3. Encoding صحيح (الأحرف العربية مفهومة)

### ٨.٢ تشغيل Test Mode

```batch
:: test-mode.bat
%INSTALL_DIR%\node\node.exe %INSTALL_DIR%\agent\src\test-mode.js
```

في هذا الوضع:
- الـ TCP server يبدأ ويستقبل الطباعة
- **لا يُمرَّر** للطابعة (للحفاظ على الورق)
- يُسجَّل كل ما يصل في `logs/test-mode.log`

### ٨.٣ صفحة التشخيص المحلية

أثناء Test Mode، يبدأ HTTP server محلي على بورت **9300** يعرض:

```
┌────────────────────────────────────────────┐
│ Queue Manager - Test Mode                  │
├────────────────────────────────────────────┤
│ Status: Listening on 192.168.1.88:9100     │
│ Last received: 12 seconds ago              │
│                                            │
│ ─── Last Print ──────────────              │
│ Bytes received: 247                        │
│                                            │
│ Hex (first 100 bytes):                     │
│ 1B 40 1B 21 30 D8 B7 D9 84 D8 A8 ...      │
│                                            │
│ Decoded as UTF-8:                          │
│ طلب رقم: 47                                 │
│ شاورما لحم                                  │
│ ...                                        │
│                                            │
│ Decoded as Windows-1256:                   │
│ ╪╖└╪╖└ ╪▄╫█└: 47                          │
│ (يبدو غير صحيح)                            │
│                                            │
│ Decoded as CP864:                          │
│ ░╓ ⌂╞┐: 47                                 │
│ (يبدو غير صحيح)                            │
│                                            │
│ ─── Extraction Results ──                  │
│ ✓ Rule "pos_default_arabic" matched        │
│   Extracted number: 47                     │
│   Confidence: high                         │
│ ✗ Rule "loyverse_arabic" did not match     │
│                                            │
│ [Send Test Print Again]                    │
└────────────────────────────────────────────┘
```

### ٨.٤ تدفق الاختبار

```
1. الفنّي يشغّل test-mode.bat
2. يفتح المتصفح على http://localhost:9300
3. يرسل طباعة تجريبية من الكاشير (طلب وهمي)
4. يرى النتائج فوراً على الصفحة
5. لو الـ encoding خاطئ → يضبطه في config.json
6. لو الـ rule لا يطابق → يحتاج إضافة rule جديدة في اللوحة السحابية
7. عند نجاح الاختبار → إيقاف Test Mode، تشغيل الخدمة العادية
```

### ٨.٥ التبديل بين الأوضاع

```batch
:: إيقاف الخدمة العادية
net stop QueueManagerAgent

:: تشغيل Test Mode
test-mode.bat

:: (بعد الاختبار)
:: إيقاف Test Mode (Ctrl+C)
:: تشغيل الخدمة العادية
net start QueueManagerAgent
```

---

## ٩. دليل التركيب للفنّي (Step-by-Step)

### المرحلة ١: التحضير (قبل الذهاب للمطعم)

- [ ] إنشاء مطعم في اللوحة السحابية
- [ ] حفظ `api_key` و `staff_pin` في مكان آمن
- [ ] تنزيل `config.json` من اللوحة
- [ ] نسخ ملفات التثبيت + config.json على USB
- [ ] التأكد من معدّات إضافية: cable Ethernet، power adapter، cable USB

### المرحلة ٢: الفحص في المطعم

- [ ] التأكد أن الكاشير يطبع فعلياً (طلب وهمي)
- [ ] فحص IP الطابعة الحالي (من إعدادات الكاشير أو Self-test)
- [ ] فحص الشبكة:
  - [ ] هل في DHCP أم IP ثابت؟
  - [ ] ما هو subnet mask و gateway؟
  - [ ] هل يوجد إنترنت؟
- [ ] فحص الجهاز المخصص للبرنامج:
  - [ ] Windows 10/11؟
  - [ ] صلاحيات admin؟
  - [ ] متصل بنفس الشبكة؟

### المرحلة ٣: تغيير IP الطابعة

- [ ] الوصول لإعدادات الطابعة (Self-test يعرض كيفية الدخول)
- [ ] تغيير IP من القديم (مثلاً 192.168.1.88) إلى الجديد (192.168.1.99)
- [ ] حفظ وإعادة تشغيل الطابعة
- [ ] طباعة Self-test جديدة للتأكد من العنوان

### المرحلة ٤: تشغيل التثبيت

- [ ] نسخ مجلد `queue-manager-installer` من USB إلى الجهاز
- [ ] فتح Command Prompt كـ Administrator
- [ ] التنقل لمجلد التثبيت
- [ ] تشغيل `install.bat`
- [ ] قراءة الملخص والتأكيد بـ `y`
- [ ] انتظار اكتمال التثبيت (1-3 دقائق)

### المرحلة ٥: الاختبار

- [ ] تشغيل `test-mode.bat`
- [ ] فتح المتصفح على `http://localhost:9300`
- [ ] إرسال طباعة تجريبية من الكاشير
- [ ] التحقق من:
  - [ ] الجهاز استقبل الطباعة
  - [ ] الـ encoding صحيح (نص عربي مقروء)
  - [ ] الرقم استُخرَج بشكل صحيح
- [ ] إذا فشل أي من ذلك:
  - [ ] للـ encoding: ضبط في config.json
  - [ ] للـ rule: تواصل مع صاحب المشروع لإضافة rule جديدة
- [ ] إيقاف Test Mode (Ctrl+C)
- [ ] تشغيل الخدمة العادية (`net start QueueManagerAgent`)

### المرحلة ٦: إعداد الشاشة

- [ ] تشغيل التلفزيون / الشاشة
- [ ] فتح المتصفح
- [ ] التنقل إلى `https://display.app.com/{restaurant_id}`
- [ ] الضغط على "ابدأ" (لتفعيل الصوت)
- [ ] التأكد أن الشاشة تعرض الواجهة بدون أخطاء

### المرحلة ٧: إعداد الموظف

- [ ] على موبايل الموظف، فتح `https://staff.app.com/{restaurant_id}`
- [ ] إدخال PIN
- [ ] إضافة الصفحة كـ shortcut على الشاشة الرئيسية
- [ ] (إذا اعتُمد الحل أ من PRD #5 ١٠.٢): تكرار الخطوات للنسخة المحلية على واي فاي المطعم

### المرحلة ٨: الاختبار النهائي (End-to-End)

- [ ] إرسال طلب حقيقي من الكاشير
- [ ] التأكد من ظهور الرقم على الشاشة (قسم "قيد التحضير")
- [ ] التأكد من ظهور الرقم على موبايل الموظف
- [ ] الضغط على "جاهز" من الموظف
- [ ] التأكد من انتقال الرقم لقسم "جاهز" على الشاشة + صدور صوت
- [ ] الضغط على "تم التسليم"
- [ ] التأكد من اختفاء الرقم

### المرحلة ٩: التسليم

- [ ] شرح للموظفين كيفية الاستخدام (5-10 دقائق)
- [ ] تسجيل ملاحظات عن أي خصوصية لهذا المطعم
- [ ] أخذ رقم الفنّي للمتابعة
- [ ] الخروج

**الزمن المتوقع للتركيب الكامل:** 2-4 ساعات في المرة الأولى، تنزل لـ 1-2 ساعة مع الخبرة.

---

## ١٠. إلغاء التثبيت

### ١٠.١ ملف `uninstall.bat`

```batch
@echo off
echo This will uninstall Queue Manager Agent.
set /p CONFIRM="Are you sure? (y/n): "
if /i not "%CONFIRM%"=="y" exit /b 0

echo Stopping service...
net stop QueueManagerAgent

echo Removing service...
"%INSTALL_DIR%\nssm.exe" remove QueueManagerAgent confirm

echo Removing IP alias...
netsh interface ip delete address "Ethernet" 192.168.1.88

echo Removing firewall rules...
netsh advfirewall firewall delete rule name="Queue Manager - Print Receiver"
netsh advfirewall firewall delete rule name="Queue Manager - Local WebSocket"
netsh advfirewall firewall delete rule name="Queue Manager - Cloud Connection"

echo Removing files...
rmdir /S /Q "%INSTALL_DIR%"

echo.
echo Uninstall complete.
echo NOTE: Don't forget to revert the printer to its original IP if needed.
pause
```

### ١٠.٢ ما لا يُحذَف

- لا يُحذَف الـ config.json من backup الأصلي على USB
- لا تُحذَف بيانات السحابة (المطعم يبقى موجود حتى لو الجهاز ما عاد يتصل)

### ١٠.٣ بعد إلغاء التثبيت

الفنّي قد يحتاج:
- إعادة الطابعة لـ IP الأصلي (إذا أراد المطعم الرجوع للعمل بدون النظام)
- إخبار الكاشير بأن النظام معطّل

---

## ١١. التحديثات

### ١١.١ آلية التحديث في النسخة 1.0

**يدوياً، عبر الفنّي.**

```
1. الفنّي يصل للمطعم (أو remote عبر AnyDesk/TeamViewer)
2. ينزّل الإصدار الجديد من الفريق
3. يشغّل update.bat:
   - يوقف الخدمة
   - ينسخ الملفات الجديدة
   - يُبقي config.json و logs و data كما هي
   - يعيد تشغيل الخدمة
4. يختبر أن كل شيء شغّال
```

### ١١.٢ Auto-Update (مؤجَّل)

في النسخة 2.0:
- البرنامج يفحص دورياً نسخة جديدة من السحابة
- يُنزّل ويُحدّث نفسه (مع reboot للخدمة)
- يبلّغ الأدمن بالتحديث

في النسخة 1.0، نتجنب هذا التعقيد. الفنّي يدير التحديث.

---

## ١٢. استكشاف الأخطاء الشائعة

### ١٢.١ الكاشير لا يرسل الطباعة

**الأعراض:** الموظف يضغط طباعة، لا شيء يحدث.

**التشخيص:**
1. هل الطابعة على نفس الشبكة؟ → `ping 192.168.1.99`
2. هل الجهاز على نفس الشبكة؟ → `ping 192.168.1.88` (من الكاشير)
3. هل الـ IP alias مُضاف؟ → `ipconfig` على الجهاز يجب أن يُظهر العنوانين
4. هل الـ Firewall يحجب البورت 9100؟

**الحلول:**
- إعادة إضافة IP alias
- مراجعة قواعد Firewall
- إعادة تشغيل الجهاز

### ١٢.٢ الطباعة تصل لكن الرقم لا يُستخرَج

**الأعراض:** Test Mode يُظهر "no rule matched".

**التشخيص:**
- مراجعة الـ encoding (هل النص العربي مقروء؟)
- مراجعة الـ rules المختارة (مناسبة لبرنامج الكاشير؟)

**الحلول:**
- ضبط `extractor.encoding` في config.json
- إضافة rule جديدة عبر اللوحة السحابية
- تحديث `extractor.rules` في config

### ١٢.٣ الخدمة تتوقف فجأة

**الأعراض:** `sc query QueueManagerAgent` يُظهر STOPPED.

**التشخيص:**
1. مراجعة logs:
   - `logs/stderr.log` — أخطاء Node.js
   - `logs/agent.log` — أحداث البرنامج
2. هل هناك حدث Windows event مرتبط؟

**الحلول:**
- بناءً على الخطأ في logs
- في الغالب: bug في البرنامج → تحديث للنسخة الأحدث

### ١٢.٤ الشاشة لا تتحدث

**التشخيص:**
1. هل WebSocket متصل؟ → فتح Developer Console على المتصفح
2. هل البرنامج المحلي يبعث events للسحابة؟ → مراجعة sync_queue
3. هل السحابة تبث للشاشة؟ → اختبار من جهاز آخر

### ١٢.٥ الموظف لا يستطيع الدخول

**التشخيص:**
1. PIN صحيح؟ → التحقق في اللوحة السحابية
2. الموظف على الشبكة الصحيحة؟
3. هل الـ session_token صالح؟ → مسح localStorage وإعادة المحاولة

---

## ١٣. معايير القبول

النسخة المنتهية تعتبر مكتملة إذا حققت كل النقاط التالية:

- [ ] حزمة التثبيت كاملة (install.bat، uninstall.bat، test-mode.bat، nssm، Node.js portable، agent، config template)
- [ ] install.bat يعمل بشكل قابل للتكرار على Windows 10 و 11
- [ ] التحقق من Administrator يعمل
- [ ] قراءة config.json بأمان قبل البدء
- [ ] إضافة IP alias تعمل وتبقى بعد reboot
- [ ] قواعد Firewall تُضاف بشكل صحيح
- [ ] Windows Service تُثبَّت وتعمل تلقائياً
- [ ] الخدمة تعيد التشغيل تلقائياً عند الفشل
- [ ] Test Mode يعرض النتائج بشكل واضح
- [ ] صفحة التشخيص المحلية تعرض hex + decoded
- [ ] uninstall.bat يلغّي كل التغييرات (alias، firewall، service، files)
- [ ] دليل التركيب موثّق ومُختبَر مع فنّي مبتدئ
- [ ] استكشاف الأخطاء الشائعة موثّق
- [ ] الـ logs منظّمة وقابلة للتشخيص

---

## ١٤. الجدول الزمني المتوقع

| اليوم | المهمة |
|------|--------|
| 1 | كتابة install.bat الأساسي + قراءة config.json |
| 2 | IP Aliasing + اكتشاف interface name |
| 3 | Firewall rules + اختبار |
| 4 | NSSM service installation + logs |
| 5 | uninstall.bat + اختبار rollback كامل |
| 6 | Test Mode (Node.js script + HTTP server) |
| 7 | صفحة التشخيص المحلية + hex viewer + multi-encoding decoder |
| 8 | كتابة دليل التركيب + screenshots |
| 9 | اختبار شامل على جهاز Windows 10 + Windows 11 |
| 10 | تعديلات على دليل التركيب بعد الاختبار |

**الإجمالي: 10 أيام عمل تقريبية.**

---

## ١٥. ملاحظات صريحة

### ١٥.١ التركيب الأول سيستغرق وقتاً أطول

أول 2-3 مطاعم: 4-6 ساعات لكل مطعم. الأسباب:
- اكتشاف خصوصيات كل برنامج كاشير
- تعلّم تغيير IP طابعات مختلفة
- أخطاء غير متوقعة

بعد 5-10 مطاعم، سيستقر الزمن على 1-2 ساعة.

### ١٥.٢ الـ install.bat ليس بديلاً عن الفنّي

البرنامج script يؤتمت **التقني** (نسخ ملفات، إعداد شبكة، تثبيت خدمة). لكن:
- إعادة إعداد الطابعة → يدوي
- اكتشاف برنامج الكاشير → يدوي
- التشخيص عند الفشل → يدوي

الفنّي مطلوب. الـ script يقلّل الوقت لا يلغّي الحاجة.

### ١٥.٣ ما يستحق الاستثمار في التحسين

بعد 5-10 تركيبات، ستكتشف نمطاً متكرراً للأخطاء. **استثمر في:**
- توثيق هذه الأخطاء
- إضافة فحوصات تلقائية للـ install.bat
- تحسين رسائل الخطأ
- مكتبة rules لبرامج كاشير شائعة

### ١٥.٤ المخاطر التشغيلية

**أكبر مخاطرة:** فقدان الطباعة بسبب bug في البرنامج (الفاتورة لا تصل للطابعة).

**التخفيف:**
- اختبار شامل قبل التركيب
- monitoring في السحابة (تنبيه لو الـ printer_status: failed > 5 دقائق)
- خطة rollback سريعة (إعادة IP الطابعة للأصلي = 5 دقائق)

**في حالة الطوارئ:** الفنّي يجب أن يعرف كيف يعزل البرنامج بسرعة (إيقاف الخدمة + إزالة IP alias) ليرجع المطعم للعمل بدون نظامنا.

---

**نهاية PRD #7. اكتمل توثيق النسخة 1.0.**
