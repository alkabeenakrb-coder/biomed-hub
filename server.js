/**
 * BioMed Hub — خادم Node.js
 * -------------------------
 * يعمل بدون أي مكتبات خارجية (بالتNode فقط).
 * التشغيل:
 *   node server.js
 * الموقع: http://localhost:3000
 *
 * الحماية:
 *  - محدة معدل الطلبات (Rate Limiting) ضد DDoS
 *  - فحص صارم للـInput وتنقية البيانات
 *  - جلسة تسجيل دخول للـAdmin برمز توكن
 *  - رؤوس أمنية (X-Frame-Options, nosniff, helmet-like)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

/* ------- إعدادات ------- */
const ADMIN_PASSWORD_HASH = '074a5a5cedd772e5664d2eb81728b10063d28ec6cb3123297ae12c9a7138af59'; // biomedhub2026 (افتراضي)
const SESSION_SECRET = crypto.randomBytes(32).toString('hex'); // يتغير كل إقلاع (ثابتة في توليد آخر)
const SESSIONS = new Map(); // token -> { ip, lastSeen }

/* ------- البيانات ------- */
function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return { posts: [], stats: { followers: '2,665', workshops: '5' }, settings: {} };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

/* كلمة المرور الحالية: من الـdata.json أو الافتراضية */
function currentPasswordHash() {
    return (db.settings && db.settings.passwordHash) || ADMIN_PASSWORD_HASH;
}

/* ------- Rate Limiting (حماية ضد الهجمات) ------- */
const WINDOW_MS = 60000;          // دقيقة
const MAX_REQUESTS = 100;         // حد للطلبات
const hits = new Map();

function rateLimited(ip) {
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, first: now };
    if (now - rec.first > WINDOW_MS) {
        rec.count = 0;
        rec.first = now;
    }
    rec.count++;
    hits.set(ip, rec);
    return rec.count > MAX_REQUESTS;
}

/* ------- تنقية النص ------- */
function cleanText(v, maxLen = 2000) {
    if (typeof v !== 'string') return '';
    // إزالة وسوم الـHTML الخبيثة والتحكميين
    return v.replace(/<[^>]*>/g, '').slice(0, maxLen).trim();
}
function cleanUrl(v, maxLen = 500) {
    if (typeof v !== 'string') return '';
    v = v.trim().slice(0, maxLen);
    // السماح بروابط http/https فقط
    if (/^https?:\/\//i.test(v)) return v;
    return '';
}
function cleanId(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

/* ------- التوكن ------- */
function createToken() {
    return crypto.randomBytes(24).toString('hex');
}
function isAuthed(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    return SESSIONS.has(token);
}

/* ------- مساعد JSON ------- */
function sendJson(res, code, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        ...extraHeaders
    });
    res.end(body);
}

/* ------- معالج الطلبات ------- */
function handleApi(req, res, url) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
        return sendJson(res, 429, { ok: false, error: 'طلبات كثيرة — حاول لاحقاً' });
    }

    const method = req.method;
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
        });
        return res.end();
    }

    // GET /api/posts
    if (method === 'GET' && pathname === '/api/posts') {
        const posts = [...db.posts].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        return sendJson(res, 200, { ok: true, posts });
    }

    // GET /api/stats
    if (method === 'GET' && pathname === '/api/stats') {
        return sendJson(res, 200, { ok: true, stats: db.stats });
    }

    // POST /api/login  ->  { password }
    if (method === 'POST' && pathname === '/api/login') {
        return readBody(req, body => {
            if (!body.password) return sendJson(res, 400, { ok: false, error: 'كلمة المرور مطلوبة' });
            const hash = crypto.createHash('sha256').update(body.password).digest('hex');
            if (hash !== currentPasswordHash()) {
                return sendJson(res, 401, { ok: false, error: 'كلمة المرور غير صحيحة' });
            }
            const token = createToken();
            SESSIONS.set(token, { createdAt: Date.now() });
            return sendJson(res, 200, { ok: true, token });
        });
    }

    // POST /api/logout
    if (method === 'POST' && pathname === '/api/logout') {
        const auth = req.headers.authorization || '';
        SESSIONS.delete(auth.replace(/^Bearer\s+/i, ''));
        return sendJson(res, 200, { ok: true });
    }

    // POST /api/change-password  ->  { currentPassword, newPassword }
    if (method === 'POST' && pathname === '/api/change-password') {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        return readBody(req, body => {
            const current = cleanText(body.currentPassword, 100);
            const next = cleanText(body.newPassword, 100);
            if (!next) return sendJson(res, 400, { ok: false, error: 'كلمة المرور الجديدة مطلوبة' });
            if (next.length < 4) return sendJson(res, 400, { ok: false, error: 'كلمة المرور قصيرة جداً (4 أحرف على الأقل)' });
            const curHash = crypto.createHash('sha256').update(current).digest('hex');
            if (curHash !== currentPasswordHash()) {
                return sendJson(res, 403, { ok: false, error: 'كلمة المرور الحالية غير صحيحة' });
            }
            const newHash = crypto.createHash('sha256').update(next).digest('hex');
            if (!db.settings) db.settings = {};
            db.settings.passwordHash = newHash;
            saveData(db);
            // تسجيل خروج جميع الجلسات لضمان الأمان
            SESSIONS.clear();
            return sendJson(res, 200, { ok: true, message: 'تم تغيير كلمة المرور — سجّل دخولك من جديد' });
        });
    }

    // المسارات المحمية
    if (method === 'POST' && pathname === '/api/posts') {
        const auth = req.headers.authorization || '';
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });

        return readBody(req, body => {
            const title = cleanText(body.title, 120);
            const content = cleanText(body.body, 2000);
            if (!title || !content) {
                return sendJson(res, 400, { ok: false, error: 'العنوان والنص مطلوبان' });
            }
            const post = {
                id: 'p' + Date.now() + Math.random().toString(36).slice(2, 7),
                title,
                body: content,
                date: cleanText(body.date, 40) || new Date().toISOString(),
                mediaType: (cleanText(body.mediaType, 10) === 'image' || cleanText(body.mediaType, 10) === 'video') ? cleanText(body.mediaType, 10) : 'none',
                mediaUrl: cleanUrl(body.mediaUrl)
            };
            db.posts.push(post);
            saveData(db);
            return sendJson(res, 201, { ok: true, post });
        });
    }

    // DELETE /api/posts/:id
    if (method === 'DELETE' && pathname.startsWith('/api/posts/')) {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        const id = cleanId(pathname.split('/').pop());
        const before = db.posts.length;
        db.posts = db.posts.filter(p => p.id !== id);
        if (db.posts.length === before) return sendJson(res, 404, { ok: false, error: 'غير موجود' });
        saveData(db);
        return sendJson(res, 200, { ok: true });
    }

    // POST /api/stats  ->  { followers, workshops }
    if (method === 'POST' && pathname === '/api/stats') {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        return readBody(req, body => {
            const f = cleanText(body.followers, 20).replace(/[^0-9,]/g, '');
            const w = cleanText(body.workshops, 20).replace(/[^0-9,]/g, '');
            if (f) db.stats.followers = f;
            if (w) db.stats.workshops = w;
            saveData(db);
            return sendJson(res, 200, { ok: true, stats: db.stats });
        });
    }

    return sendJson(res, 404, { ok: false, error: 'غير موجود' });
}

/* ------- قراءة JSON ------- */
function readBody(req, cb) {
    let raw = '';
    req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 5_000_000) { req.destroy(); return; }
        // تجاهل الـBody إن كان كبيراً
    });
    req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {
            // محاولة parse كـ urlencoded (اختياري)
            try {
                const url = new URLSearchParams(raw);
                url.forEach((v, k) => { body[k] = v; });
            } catch (e2) { body = {}; }
        }
        cb(body);
    });
    req.on('error', () => cb({}));
}

/* ------- خدمة الملفات الثابتة ------- */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
};
const ALLOWED_FILES = ['index.html', 'admin.html', 'IMG_9090.PNG', 'M.png', 'favicon.ico'];

function serveStatic(req, res, url) {
    const pathname = url.pathname;
    let file = pathname === '/' || pathname === '/index' ? 'index.html' : pathname.replace(/^\/+/, '');

    // منع المجموعه من الخروج (Path Traversal)
    const safePath = path.resolve(ROOT, file);
    if (!safePath.startsWith(ROOT) || !ALLOWED_FILES.includes(path.basename(file))) {
        res.writeHead(403);
        return res.end('403 Forbidden');
    }

    const full = path.join(ROOT, file);
    fs.readFile(full, (err, data) => {
        if (err) {
            // Admin page are linked from index; fallback to index.html
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<h1>404 — الصفحة غير موجودة</h1>');
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Cache-Control': 'public, max-age=3600'
        });
        res.end(data);
    });
}

/* ------- الخادم ------- */
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
        return handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
});

server.listen(PORT, () => {
    console.log(`BioMed Hub server يعمل على: http://localhost:${PORT}`);
    console.log('لوحة الإدارة: http://localhost:' + PORT + '/admin.html');
});