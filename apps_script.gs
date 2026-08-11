/**
 * BioMed Hub — واجهة حفظ المنشورات عبر Google Apps Script
 * -------------------------------------------------------
 * الخطوات:
 * 1) افتح script.google.com وأنشئ مشروع جديد.
 * 2) انسخ هذا الكود كاملاً داخل المحرر.
 * 3) انشر: Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - خذ الرابط الذي يبدأ بـ https://script.google.com/macros/s/...
 * 4) ضع الرابط في مكانين:
 *    - admin.html  → ثابت POSTS_API
 *    - index.html  → ثابت POSTS_API
 *
 * ملاحظة أمنية: حدد صلاحية من يقرأ محتوى الجدول فقط، وكلمة المرور (adminKey)
 * تُرسَل عبر الطلب نفسه، لذا اعتمد على هذا الحل لموقعك الحالي البسيط فقط.
 */

/**
 * BioMed Hub — واجهة حفظ المنشورات عبر Google Apps Script
 * -------------------------------------------------------
 * الخطوات:
 * 1) افتح script.google.com وأنشئ مشروع جديد.
 * 2) انسخ هذا الكود كاملاً داخل المحرر.
 * 3) انشر: Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - خذ الرابط الذي يبدأ بـ https://script.google.com/macros/s/...
 * 4) ضع الرابط في مكانين:
 *    - admin.html  → ثابت POSTS_API
 *    - index.html  → ثابت POSTS_API
 *
 * ملاحظة أمنية: حدد صلاحية من يقرأ محتوى الجدول فقط، وكلمة المرور (adminKey)
 * تُرسَل عبر الطلب نفسه، لذا اعتمد على هذا الحل لموقعك الحالي البسيط فقط.
 */

const SHEET_NAME = 'posts'; // اسم الورقة داخل جدول البيانات (أنشئها أولاً)
const ADMIN_KEY = '074a5a5cedd772e5664d2eb81728b10063d28ec6cb3123297ae12c9a7138af59'; // نفس هاش index.html

function doGet(e) {
  try {
    const sheet = getPostsSheet();
    const rows = sheet.getDataRange().getValues();

    // تخطي رأس الجدول إن وجد
    const header = rows.shift() || [];
    let posts = rows.map(r => ({
      id: String(r[0] || ''),
      title: String(r[1] || ''),
      body: String(r[2] || ''),
      date: String(r[3] || ''),
      mediaType: String(r[4] || ''),
      mediaUrl: String(r[5] || '')
    }));

    // استبعاد المنشورات الفارغة
    posts = posts.filter(function(p){ return p.title && p.body; });
    posts.sort(function(a,b){ return (b.date < a.date) ? -1 : 1; });

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, posts: posts }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return jsonError('GET: ' + error.message);
  }
}

function doPost(e) {
  try {
    var params = {};
    if (e && e.postData && e.postData.contents) {
      var raw = e.postData.contents;
      try {
        params = JSON.parse(raw);
      } catch (err) {
        // تنسيق x-www-form-urlencoded (كما يرسل لوحة الإدارة)
        raw.split('&').forEach(function (pair) {
          var kv = pair.split('=');
          try { params[kv[0]] = decodeURIComponent(kv[1] || ''); }
          catch (err2) { params[kv[0]] = kv[1] || ''; }
        });
      }
    }

    var key = params.adminKey || '';
    if (key !== ADMIN_KEY) return jsonError('unauthorized');
    if (!params.title || !params.body) return jsonError('missing fields');

    var sheet = getActiveSheet();
    var row = [
      'p' + Date.now(),
      String(params.title),
      String(params.body),
      String(params.date || new Date().toISOString()),
      String(params.mediaType || ''),
      String(params.mediaUrl || '')
    ];
    sheet.appendRow(row);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return jsonError('add: ' + error.message);
  }
}

function doMaster(e) {
  if (e && e.postData && e.postData.contents) {
    return doPost(e);
  }
  return doGet(e);
}

function getPostsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function getActiveSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  // تكتّب رأس الجدول عند الحاجة
  const last = sheet.getLastRow();
  if (last === 0) {
    sheet.appendRow(['id', 'title', 'body', 'date', 'mediaType', 'mediaUrl']);
  }
  return sheet;
}

function jsonError(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: String(message) }))
    .setMimeType(ContentService.MimeType.JSON);
}