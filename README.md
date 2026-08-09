# BioMed Hub — منصة الهندسة الطبية

الموقع + لوحة إدارة مبنية بلغة **Node.js** أو **Python** (خيارك) مع حماية مدمجة.

## التشغيل

### الخيار 1: Node.js (موصى به — بدون مكتبات خارجية)
```bash
node server.js
```
افتح: **http://localhost:8080** — لوحة الإدارة: **http://localhost:8080/admin.html**

### الخيار 2: Python
```bash
pip install -r requirements.txt
python server.py
```
افتح: **http://localhost:5000** — لوحة الإدارة: **http://localhost:5000/admin.html**

> إن كان المنفذ مشغولاً غيّره بسيطاً:
> `PORT=4000 node server.js` (لـNode) أو عدل `port` في `server.py`.

## كلمة المرور
- كلمة المرور الافتراضية للوحة الإدارة: **biomedhub2026**
- لتغييرها: احسب SHA-256 للكلمة الجديدة وضعها في `ADMIN_PASSWORD_HASH` في الثلاثة ملفات (`server.js`, `server.py`, `admin.html`).

## الملفات
| الملف | الوظيفة |
|---|---|
| `index.html` | الصفحة الرئيسية (المنشورات + الورش + الإحصائيات + الفلتر) |
| `admin.html` | لوحة الإدارة (نشر نص/صورة/فيديو، تعديل الأرقام، حذف) |
| `server.js` | خادم Node.js + واجهة برمجة (API) + حماية |
| `server.py` | خادم Python تعادل وظيفياً |
| `data.json` | ملف البيانات (المنشورات والأرقام) |
| `IMG_9090.PNG` | شعار المنصة |
| `apps_script.gs` | (اختياري) بديل Google Sheets — غير مطلوب مع الخادم |

## الحماية المدمجة
- ✅ محدة معدل الطلبات (Rate Limiting) ضد DDoS — 100 طلب/دقيقة للـIP
- ✅ منع حقن XSS في الإدخالات
- ✅ رفض Path Traversal في الملفات
- ✅ جلسات تسجيل دخول للـAdmin برمز توكن
- ✅ رؤوس أمنية (X-Frame-Options DENY, nosniff, Referrer-Policy)
- ✅ فحص وتحقق صارم من وسوم HTML في النصوص

> ملاحظة: للحماية من DDoS الكامل على الإنترنت استضف الموقع خلف Cloudflare (مجاني) وأشفّر الاتصال بـ HTTPS.

## الحقوق
جميع الحقوق محفوظة © 2026 — **مهيمن حسنين — فريق SYSTEM32**