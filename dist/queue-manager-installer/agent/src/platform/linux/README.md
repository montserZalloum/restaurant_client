# Linux Platform — محجوز للمستقبل

هذا المجلد محجوز لتطبيق `PlatformAdapter` على Linux. **لم يُنفَّذ بعد** ولن يُنفَّذ في النسخة 1.0 من النظام.

## السبب

النسخة الأولى تستهدف **Windows فقط** لأن:

١. كل المطاعم في السوق المستهدف تُشغّل أنظمة الكاشير على Windows.
٢. آلية اعتراض الطباعة عبر **IP alias** على نفس الواجهة تعتمد على سلوك Windows TCP stack تحديداً.
٣. تثبيت البرنامج كخدمة يستخدم Windows Service Control Manager (SCM) عبر `node-windows` أو `nssm`.

## ما يجب فعله عند دعم Linux

عند الحاجة لدعم Linux في النسخة المستقبلية، يجب تطبيق نفس الواجهة في `src/platform/interface.js` بالطرق التالية:

| الطريقة | تطبيق Linux المقترح |
|---|---|
| `getDataDir/getConfigDir/getLogDir` | `/var/lib/queue-manager`, `/etc/queue-manager`, `/var/log/queue-manager` |
| `installAsService` | إنشاء `systemd` unit في `/etc/systemd/system/` |
| `uninstallService` | `systemctl disable && rm` للـ unit file |
| `isServiceInstalled` | فحص وجود الـ unit file |
| `setupPrintInterception` | `iptables` NAT أو IP alias عبر `ip addr add` |
| `teardownPrintInterception` | عكس القاعدة |
| `configureFirewall` | `iptables` أو `ufw` |
| `getLocalIpAddresses` | نفس Windows (`os.networkInterfaces()`) |
| `ensureIpAliasPersistent` | كتابة في `/etc/network/interfaces.d/` أو ملف netplan |
| `logSystemEvent` | `logger` (syslog) أو `journalctl` عبر `systemd-cat` |

## استثناء التشغيل

`src/platform/index.js` يرفض حالياً أي platform غير `win32`:

```javascript
throw new Error('Unsupported platform: ${process.platform}. Only win32 is supported in v1.0.')
```

عند إضافة Linux، أضف فرع `else if (process.platform === 'linux')` يُرجِع instance من `LinuxAdapter`.
