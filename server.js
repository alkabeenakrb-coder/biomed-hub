/**
 * BioMed Hub — خادم Node.js
 * -------------------------
 * يعمل بدون أي مكتبات خارجية (بالتNode فقط).
 * التشغيل:
 *   node server.js
 * الموقع: http://localhost:8080
 * البث المباشر: http://localhost:8080/live.html
 *
 * المميزات:
 *  - منشورات + إحصائيات + لوحة إدارة
 *  - بث مباشر بأسلوب "ميت": كتم، تعليقات، رفع اليد (الأدمن فقط يبث)
 *  - تسجيل البث وحفظه داخل المنصة (مجلد recordings)
 *  - WebSocket للتحديث اللحظي (تعليقات/كتم/رفع يد/إشارات WebRTC)
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
const RECORDING_DIR = path.join(ROOT, 'recordings');
if (!fs.existsSync(RECORDING_DIR)) fs.mkdirSync(RECORDING_DIR);

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
    return v.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
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

/* ------- قراءة JSON ------- */
function readBody(req, cb) {
    let raw = '';
    req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 5_000_000) { req.destroy(); return; }
    });
    req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {
            try {
                const url = new URLSearchParams(raw);
                url.forEach((v, k) => { body[k] = v; });
            } catch (e2) { body = {}; }
        }
        cb(body);
    });
    req.on('error', () => cb({}));
}

/* قراءة البيانات الخام (لرفع مقاطع التسجيل) */
function readRawBody(req, cb, limit) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', c => {
        if (done) return;
        size += c.length;
        if (size > limit) { req.destroy(); done = true; return; }
        chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; cb(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!done) { done = true; cb(Buffer.alloc(0)); } });
}

/* ------- حالة البث المباشر (WebSocket room) ------- */
const live = {
    isLive: false,
    title: '',
    startedAt: null,
    admin: null,          // socket الأدمن
    adminInfo: null,
    viewers: new Map(),   // viewerId -> { id, name, socket, muted, hand }
    messages: [],         // رسائل التعليقات
    chatOpen: true,       // هل التعليقات مفتوحة؟
    viewersMuted: false   // كتم جميع الحاضرين
};

function viewerBySocket(socket) {
    for (const v of live.viewers.values()) if (v.socket === socket) return v;
    return null;
}

function broadcast(obj, excludeSocket) {
    if (live.admin && live.admin !== excludeSocket) wsSend(live.admin, obj);
    for (const v of live.viewers.values()) {
        if (v.socket !== excludeSocket) wsSend(v.socket, obj);
    }
}

function relay(socket, obj) {
    if (socket && !socket.destroyed) wsSend(socket, obj);
}

function viewerPublic(v) {
    return { id: v.id, name: v.name, muted: v.muted, hand: v.hand, requested: v.requested, presenting: v.presenting };
}

function peerSocket(targetId) {
    if (targetId === 'admin') return live.admin;
    const v = live.viewers.get(targetId);
    return v ? v.socket : null;
}

function snapshotAdmin() {
    return {
        type: 'welcome',
        role: 'admin',
        live: live.isLive,
        title: live.title,
        startedAt: live.startedAt,
        chatOpen: live.chatOpen,
        viewersMuted: live.viewersMuted,
        viewers: [...live.viewers.values()].map(viewerPublic),
        messages: live.messages.slice(-100)
    };
}

/* ------- WebSocket (RFC 6455) من الصفر ------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsSend(socket, obj) {
    if (!socket || socket.destroyed) return;
    let payload;
    try { payload = Buffer.from(JSON.stringify(obj), 'utf8'); } catch (e) { return; }
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
}

function handleWsMessage(socket, msg) {
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    const isAdmin = (live.admin === socket);
    const viewer = viewerBySocket(socket);

    switch (msg.type) {

        case 'join': {
            if (msg.mode === 'admin') {
                if (live.admin) {
                    wsSend(socket, { type: 'error', error: 'يوجد أدمن آخر متصل بالبث' });
                    try { socket.end(); } catch (e) {}
                    return;
                }
                live.admin = socket;
                live.adminInfo = { id: cleanId(msg.viewerId) || 'admin' };
                wsSend(socket, snapshotAdmin());
                return;
            }
            let id = cleanId(msg.viewerId);
            if (!id || live.viewers.has(id)) {
                id = 'v' + Date.now().toString(36) + Math.floor(Math.random() * 10000).toString(36);
            }
            const name = cleanText(msg.name, 40) || 'مشاهد';
            live.viewers.set(id, { id, name, socket, muted: false, hand: false, requested: false, presenting: false });
            broadcast({ type: 'viewer-joined', viewer: viewerPublic(live.viewers.get(id)) }, socket);
            broadcast({ type: 'viewers', count: live.viewers.size }, socket);
            // إن كان هناك مشارك يبث — اطلب منه إرسال البث إلى الوافد الجديد
            for (const p of live.viewers.values()) {
                if (p.presenting && p.socket !== socket) relay(p.socket, { type: 'presenter-peer', peerId: id });
            }
            wsSend(socket, {
                type: 'welcome',
                role: 'viewer',
                live: live.isLive,
                title: live.title,
                startedAt: live.startedAt,
                chatOpen: live.chatOpen,
                viewersMuted: live.viewersMuted,
                viewers: live.viewers.size,
                messages: live.messages.slice(-100)
            });
            return;
        }

        case 'chat': {
            if (!viewer) return;
            if (!live.chatOpen) { wsSend(socket, { type: 'error', error: 'التعليقات موقوفة حالياً' }); return; }
            const text = cleanText(msg.text, 300);
            if (!text) return;
            const m = { id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36), name: viewer.name, text, time: new Date().toISOString() };
            live.messages.push(m);
            if (live.messages.length > 500) live.messages.splice(0, live.messages.length - 500);
            broadcast({ type: 'chat', message: m });
            return;
        }

        case 'delete-chat': {
            if (!isAdmin) return;
            const id = cleanId(msg.id);
            live.messages = live.messages.filter(m => m.id !== id);
            broadcast({ type: 'chat-deleted', id });
            return;
        }

        case 'raise-hand': {
            if (!viewer) return;
            viewer.hand = !!msg.up;
            if (viewer.hand) {
                broadcast({ type: 'hand-raised', viewer: { id: viewer.id, name: viewer.name } });
            } else {
                broadcast({ type: 'hand-dismissed', viewerId: viewer.id });
            }
            return;
        }

        case 'hand-decision': {
            if (!isAdmin) return;
            const v = live.viewers.get(cleanId(msg.viewerId));
            if (!v) return;
            v.hand = false;
            broadcast({ type: 'hand-dismissed', viewerId: v.id });
            if (msg.decision === 'accept') {
                relay(v.socket, { type: 'hand-accepted' });
            }
            return;
        }

        case 'mute-user': {
            if (!isAdmin) return;
            const v = live.viewers.get(cleanId(msg.viewerId));
            if (!v) return;
            v.muted = !!msg.muted;
            relay(v.socket, { type: 'muted', muted: v.muted });
            broadcast({ type: 'viewer-updated', viewer: viewerPublic(v) });
            return;
        }

        case 'mute-all': {
            if (!isAdmin) return;
            live.viewersMuted = !!msg.muted;
            broadcast({ type: 'muted-all', muted: live.viewersMuted });
            return;
        }

        case 'toggle-chat': {
            if (!isAdmin) return;
            live.chatOpen = !!msg.open;
            broadcast({ type: 'chat-toggled', open: live.chatOpen });
            return;
        }

        case 'kick-user': {
            if (!isAdmin) return;
            const v = live.viewers.get(cleanId(msg.viewerId));
            if (!v) return;
            if (v.presenting) broadcast({ type: 'share-stopped', viewerId: v.id });
            try { relay(v.socket, { type: 'kicked' }); v.socket.end(); } catch (e) {}
            live.viewers.delete(v.id);
            broadcast({ type: 'viewer-left', viewerId: v.id });
            broadcast({ type: 'viewers', count: live.viewers.size });
            return;
        }

        /* ===== مشاركة/بث من ضيف بإذن الأدمن ===== */
        case 'request-share': {
            if (!viewer) return;
            viewer.requested = true;
            broadcast({ type: 'share-request', viewer: viewerPublic(viewer) });
            return;
        }

        case 'share-decision': {
            if (!isAdmin) return;
            const v = live.viewers.get(cleanId(msg.viewerId));
            if (!v) return;
            v.requested = false;
            if (msg.decision === 'approve') {
                v.presenting = true;
                const peers = [...live.viewers.keys()].filter(id => id !== v.id);
                relay(v.socket, { type: 'presenter-go', peers });
                broadcast({ type: 'share-approved', viewer: viewerPublic(v) });
            } else if (msg.decision === 'stop') {
                v.presenting = false;
                relay(v.socket, { type: 'share-stopped', viewerId: v.id });
                broadcast({ type: 'share-stopped', viewerId: v.id });
            } else {
                relay(v.socket, { type: 'share-denied' });
            }
            broadcast({ type: 'viewer-updated', viewer: viewerPublic(v) });
            return;
        }

        case 'stop-share': {
            if (!viewer || !viewer.presenting) return;
            viewer.presenting = false;
            broadcast({ type: 'share-stopped', viewerId: viewer.id });
            broadcast({ type: 'viewer-updated', viewer: viewerPublic(viewer) });
            return;
        }

        case 'start-broadcast': {
            if (!isAdmin) return;
            live.isLive = true;
            live.title = cleanText(msg.title, 120) || 'بث مباشر';
            live.startedAt = new Date().toISOString();
            broadcast({ type: 'live-started', title: live.title, startedAt: live.startedAt });
            return;
        }

        case 'stop-broadcast': {
            if (!isAdmin) return;
            live.isLive = false;
            broadcast({ type: 'live-stopped' });
            return;
        }

        /* ==== إشارات WebRTC (توجيه بين أي طرفين) ==== */
        case 'offer': {
            const from = isAdmin ? 'admin' : (viewer ? viewer.id : null);
            if (!from) return;
            const t = peerSocket(cleanId(msg.to));
            if (t) relay(t, { type: 'offer', sdp: msg.sdp, from, name: viewer ? viewer.name : undefined });
            return;
        }

        case 'answer': {
            const from = isAdmin ? 'admin' : (viewer ? viewer.id : null);
            if (!from) return;
            const t = peerSocket(cleanId(msg.to));
            if (t) relay(t, { type: 'answer', sdp: msg.sdp, from });
            return;
        }

        case 'ice': {
            const from = isAdmin ? 'admin' : (viewer ? viewer.id : null);
            if (!from) return;
            const t = peerSocket(cleanId(msg.to));
            if (t) relay(t, { type: 'ice', candidate: msg.candidate, from });
            return;
        }

        case 'ping': {
            wsSend(socket, { type: 'pong' });
            return;
        }
    }
}

function onSocketClose(socket) {
    if (live.admin === socket) {
        live.admin = null;
        live.adminInfo = null;
        live.isLive = false;
        broadcast({ type: 'live-stopped' });
        return;
    }
    for (const [id, v] of live.viewers) {
        if (v.socket === socket) {
            if (v.presenting) broadcast({ type: 'share-stopped', viewerId: id });
            live.viewers.delete(id);
            broadcast({ type: 'viewer-left', viewerId: id });
            broadcast({ type: 'viewers', count: live.viewers.size });
            return;
        }
    }
}

function attachWebSocket(server) {
    server.on('upgrade', (req, socket) => {
        try {
            const u = new URL(req.url, 'http://localhost');
            if (u.pathname !== '/ws') { socket.destroy(); return; }
            if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
            const key = req.headers['sec-websocket-key'];
            if (!key) { socket.destroy(); return; }
            const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
            );
            socket.setNoDelay(true);

            const token = u.searchParams.get('token') || '';
            const isAdminConn = SESSIONS.has(token);
            if (isAdminConn) wsSend(socket, { type: 'auth-ok' });

            let buffer = Buffer.alloc(0);
            let closed = false;
            const close = () => {
                if (closed) return;
                closed = true;
                try { socket.destroy(); } catch (e) {}
                onSocketClose(socket);
            };
            socket.on('error', close);
            socket.on('close', close);

            socket.on('data', chunk => {
                buffer = Buffer.concat([buffer, chunk]);
                while (!closed && buffer.length >= 2) {
                    const opcode = buffer[0] & 0x0f;
                    const masked = (buffer[1] & 0x80) === 0x80;
                    let len = buffer[1] & 0x7f;
                    let offset = 2;
                    if (len === 126) {
                        if (buffer.length < 4) break;
                        len = buffer.readUInt16BE(2); offset = 4;
                    } else if (len === 127) {
                        if (buffer.length < 10) break;
                        len = Number(buffer.readBigUInt64BE(2)); offset = 10;
                    }
                    if (len > 5_000_000) { close(); return; }
                    if (buffer.length < offset + (masked ? 4 : 0) + len) break;
                    let mask;
                    if (masked) { mask = buffer.subarray(offset, offset + 4); offset += 4; }
                    const payload = Buffer.from(buffer.subarray(offset, offset + len));
                    buffer = buffer.subarray(offset + len);
                    if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
                    if (opcode === 0x1) {
                        try {
                            const msg = JSON.parse(payload.toString('utf8'));
                            if (msg && msg.type === 'join' && msg.mode === 'admin' && !isAdminConn) {
                                wsSend(socket, { type: 'error', error: 'غير مصرح — هذا رابط أدمن' });
                                close();
                                return;
                            }
                            handleWsMessage(socket, msg);
                        } catch (e) {}
                    } else if (opcode === 0x8) { close(); return; }
                }
            });
        } catch (e) {
            try { socket.destroy(); } catch (e2) {}
        }
    });
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
            SESSIONS.clear();
            return sendJson(res, 200, { ok: true, message: 'تم تغيير كلمة المرور — سجّل دخولك من جديد' });
        });
    }

    // POST /api/posts  (محمي)
    if (method === 'POST' && pathname === '/api/posts') {
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

    // DELETE /api/posts/:id (محمي)
    if (method === 'DELETE' && pathname.startsWith('/api/posts/')) {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        const id = cleanId(pathname.split('/').pop());
        const before = db.posts.length;
        db.posts = db.posts.filter(p => p.id !== id);
        if (db.posts.length === before) return sendJson(res, 404, { ok: false, error: 'غير موجود' });
        saveData(db);
        return sendJson(res, 200, { ok: true });
    }

    // POST /api/stats (محمي)
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

    /* ================== البث المباشر ================== */

    // GET /api/live/status  ->  حالة البث (عام)
    if (method === 'GET' && pathname === '/api/live/status') {
        return sendJson(res, 200, {
            ok: true,
            live: live.isLive,
            title: live.title,
            startedAt: live.startedAt,
            viewers: live.viewers.size,
            chatOpen: live.chatOpen,
            viewersMuted: live.viewersMuted
        });
    }

    // POST /api/live/start  ->  { title } (محمي)
    if (method === 'POST' && pathname === '/api/live/start') {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        return readBody(req, body => {
            live.isLive = true;
            live.title = cleanText(body.title, 120) || 'بث مباشر';
            live.startedAt = new Date().toISOString();
            broadcast({ type: 'live-started', title: live.title, startedAt: live.startedAt });
            return sendJson(res, 200, { ok: true, live: live.isLive, title: live.title });
        });
    }

    // POST /api/live/stop (محمي)
    if (method === 'POST' && pathname === '/api/live/stop') {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        live.isLive = false;
        broadcast({ type: 'live-stopped' });
        return sendJson(res, 200, { ok: true });
    }

    /* ================== التسجيلات ================== */

    // POST /api/recordings/upload?session=xxx&index=n  (محمي) — إلحاق مقطع
    if (method === 'POST' && pathname === '/api/recordings/upload') {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        const session = cleanId(url.searchParams.get('session'));
        if (!session) return sendJson(res, 400, { ok: false, error: 'رقم الجلسة مطلوب' });
        readRawBody(req, buf => {
            if (!buf.length) return sendJson(res, 400, { ok: false, error: 'لا توجد بيانات' });
            fs.appendFile(path.join(RECORDING_DIR, session + '.webm'), buf, err => {
                if (err) return sendJson(res, 500, { ok: false, error: 'فشل حفظ المقطع' });
                sendJson(res, 200, { ok: true });
            });
        }, 30 * 1024 * 1024);
        return;
    }

    // POST /api/recordings/finish  ->  { session, title } (محمي)
    if (method === 'POST' && pathname === '/api/recordings/finish') {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        return readBody(req, body => {
            const session = cleanId(body.session);
            if (!session) return sendJson(res, 400, { ok: false, error: 'رقم الجلسة مطلوب' });
            const file = session + '.webm';
            fs.stat(path.join(RECORDING_DIR, file), (err, st) => {
                if (err) return sendJson(res, 404, { ok: false, error: 'التسجيل غير موجود' });
                if (!db.recordings) db.recordings = [];
                const title = cleanText(body.title, 120) || 'بث مباشر';
                db.recordings.push({
                    id: session,
                    file,
                    title,
                    createdAt: new Date().toISOString(),
                    size: st.size
                });
                saveData(db);
                return sendJson(res, 200, { ok: true, recording: db.recordings[db.recordings.length - 1] });
            });
        });
    }

    // GET /api/recordings  ->  قائمة التسجيلات
    if (method === 'GET' && pathname === '/api/recordings') {
        const list = (db.recordings || []).slice().reverse();
        return sendJson(res, 200, { ok: true, recordings: list });
    }

    // DELETE /api/recordings/:id (محمي)
    if (method === 'DELETE' && pathname.startsWith('/api/recordings/')) {
        if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'غير مصرح' });
        const id = cleanId(pathname.split('/').pop());
        const rec = (db.recordings || []).find(r => r.id === id);
        if (!rec) return sendJson(res, 404, { ok: false, error: 'غير موجود' });
        db.recordings = db.recordings.filter(r => r.id !== id);
        saveData(db);
        try { fs.unlinkSync(path.join(RECORDING_DIR, rec.file)); } catch (e) {}
        return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'غير موجود' });
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
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
};
const ALLOWED_FILES = ['index.html', 'admin.html', 'live.html', 'IMG_9090.PNG', 'logo.png', 'logo.jpg', 'logo.svg', 'favicon.ico'];

function serveStatic(req, res, url) {
    const pathname = url.pathname;

    // ملفات التسجيلات المحفوظة داخل المنصة
    if (pathname.startsWith('/recordings/')) {
        const file = pathname.replace(/^\/recordings\//, '');
        if (!/^[a-zA-Z0-9_-]+\.(webm|mp4)$/.test(file)) {
            res.writeHead(403, { 'X-Content-Type-Options': 'nosniff' });
            return res.end('403 Forbidden');
        }
        const full = path.resolve(RECORDING_DIR, file);
        if (!full.startsWith(path.resolve(RECORDING_DIR))) {
            res.writeHead(403, { 'X-Content-Type-Options': 'nosniff' });
            return res.end('403 Forbidden');
        }
        fs.readFile(full, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<h1>404 — التسجيل غير موجود</h1>');
            }
            res.writeHead(200, {
                'Content-Type': MIME['.webm'] || 'video/webm',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(data);
        });
        return;
    }

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
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<h1>404 — الصفحة غير موجودة</h1>');
        }
        const ext = path.extname(file).toLowerCase();
        const isHtml = ext === '.html';
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Cache-Control': isHtml ? 'no-store, max-age=0' : 'public, max-age=3600'
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

attachWebSocket(server);

server.listen(PORT, () => {
    console.log(`BioMed Hub server يعمل على: http://localhost:${PORT}`);
    console.log('لوحة الإدارة: http://localhost:' + PORT + '/admin.html');
    console.log('البث المباشر: http://localhost:' + PORT + '/live.html');
});
