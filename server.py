# -*- coding: utf-8 -*-
"""
BioMed Hub — خادم Python (Flask)
--------------------------------
التشغيل:
    pip install flask
    python server.py

الموقع: http://localhost:5001

الحماية:
 - محدة معدل الطلبات (Rate Limiting) ضد DDoS
 - تنقية المدخلات والتحقق منها
 - جلسة تسجيل دخول للـAdmin
 - رؤوس أمنية
"""

import os
import re
import time
import random
import hashlib
import secrets
import json
from datetime import datetime, timezone, timezone

from flask import Flask, jsonify, request, send_from_directory, abort

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(APP_DIR, 'data.json')

ADMIN_PASSWORD_HASH = '074a5a5cedd772e5664d2eb81728b10063d28ec6cb3123297ae12c9a7138af59'  # biomedhub2026

app = Flask(__name__, static_folder=None, static_url_path='')

# ---------------- Data ----------------
def load_data():
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'posts': [], 'stats': {'followers': '2,665', 'workshops': '5'}, 'settings': {}}

def save_data(data):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

DB = load_data()
TOKENS = set()

def current_password_hash():
    return DB.get('settings', {}).get('passwordHash') or ADMIN_PASSWORD_HASH

# ---------------- Rate limiting ----------------
HITS = {}
WINDOW_MS = 60 * 1000   # دقيقة
MAX_REQUESTS = 100

def is_rate_limited(ip):
    now = time.time() * 1000
    rec = HITS.get(ip, {'count': 0, 'first': now})
    if now - rec['first'] > WINDOW_MS:
        rec = {'count': 0, 'first': now}
    rec['count'] += 1
    HITS[ip] = rec
    return rec['count'] > MAX_REQUESTS

# ---------------- Helpers ----------------
def clean_text(v, max_len=2000):
    if not isinstance(v, str):
        return ''
    return re.sub(r'<[^>]*>', '', v)[:max_len].strip()

def clean_url(v, max_len=500):
    if not isinstance(v, str):
        return ''
    v = v.strip()[:max_len]
    if re.match(r'^https?://', v, re.IGNORECASE):
        return v
    return ''

def clean_id(v):
    if not isinstance(v, str):
        return ''
    return re.sub(r'[^a-zA-Z0-9_-]', '', v)[:32]

def is_token_auth():
    token = (request.headers.get('Authorization', '')).replace('Bearer ', '').strip()
    return token in TOKENS

# ---------------- Security headers ----------------
@app.before_request
def security():
    try:
        ip = request.remote_addr or 'unknown'
        if is_rate_limited(ip):
            return jsonify(ok=False, error='طلبات كثيرة — حاول لاحقاً'), 429
    except Exception:
        pass

@app.after_request
def add_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response

# ---------------- API ----------------
@app.route('/api/posts', methods=['GET'])
def get_posts():
    posts = sorted(DB['posts'], key=lambda p: p.get('date', ''), reverse=True)
    return jsonify(ok=True, posts=posts)

@app.route('/api/posts', methods=['POST'])
def add_post():
    if not is_token_auth():
        return jsonify(ok=False, error='غير مصرح'), 401
    body = request.get_json(force=True, silent=True) or {}
    title = clean_text(body.get('title'), 120)
    content = clean_text(body.get('body'), 2000)
    if not title or not content:
        return jsonify(ok=False, error='العنوان والنص مطلوبان'), 400

    media_type = clean_text(body.get('mediaType'), 10)
    if media_type not in ('image', 'video'):
        media_type = 'none'

    post = {
        'id': 'p' + str(int(time.time())) + ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=6)),
        'title': title,
        'body': content,
        'date': clean_text(body.get('date'), 40) or datetime.now(timezone.utc).isoformat(),
        'mediaType': media_type,
        'mediaUrl': clean_url(body.get('mediaUrl')),
    }
    DB['posts'].append(post)
    save_data(DB)
    return jsonify(ok=True, post=post), 201

@app.route('/api/posts/<post_id>', methods=['DELETE'])
def delete_post(post_id):
    if not is_token_auth():
        return jsonify(ok=False, error='غير مصرح'), 401
    post_id = clean_id(post_id)
    before = len(DB['posts'])
    DB['posts'] = [p for p in DB['posts'] if p.get('id') != post_id]
    if len(DB['posts']) == before:
        return jsonify(ok=False, error='غير موجود'), 404
    save_data(DB)
    return jsonify(ok=True)

@app.route('/api/stats', methods=['GET'])
def get_stats():
    return jsonify(ok=True, stats=DB['stats'])

@app.route('/api/stats', methods=['POST'])
def set_stats():
    if not is_token_auth():
        return jsonify(ok=False, error='غير مصرح'), 401
    body = request.get_json(force=True, silent=True) or {}
    f = re.sub(r'[^0-9,]', '', clean_text(body.get('followers'), 20))
    w = re.sub(r'[^0-9,]', '', clean_text(body.get('workshops'), 20))
    if f:
        DB['stats']['followers'] = f
    if w:
        DB['stats']['workshops'] = w
    save_data(DB)
    return jsonify(ok=True, stats=DB['stats'])

@app.route('/api/login', methods=['POST'])
def login():
    body = request.get_json(force=True, silent=True) or {}
    password = body.get('password') or ''
    if hashlib.sha256(password.encode('utf-8')).hexdigest() != current_password_hash():
        return jsonify(ok=False, error='كلمة المرور غير صحيحة'), 401
    token = secrets.token_hex(24)
    TOKENS.add(token)
    return jsonify(ok=True, token=token)

@app.route('/api/change-password', methods=['POST'])
def change_password():
    if not is_token_auth():
        return jsonify(ok=False, error='غير مصرح'), 401
    body = request.get_json(force=True, silent=True) or {}
    current = clean_text(body.get('currentPassword'), 100)
    next_pwd = clean_text(body.get('newPassword'), 100)
    if not next_pwd:
        return jsonify(ok=False, error='كلمة المرور الجديدة مطلوبة'), 400
    if len(next_pwd) < 4:
        return jsonify(ok=False, error='كلمة المرور قصيرة جداً (4 أحرف على الأقل)'), 400
    if hashlib.sha256(current.encode('utf-8')).hexdigest() != current_password_hash():
        return jsonify(ok=False, error='كلمة المرور الحالية غير صحيحة'), 403
    DB.setdefault('settings', {})['passwordHash'] = hashlib.sha256(next_pwd.encode('utf-8')).hexdigest()
    save_data(DB)
    TOKENS.clear()
    return jsonify(ok=True, message='تم تغيير كلمة المرور — سجّل دخولك من جديد')

@app.route('/api/logout', methods=['POST'])
def logout():
    token = (request.headers.get('Authorization', '').replace('Bearer ', '')).strip()
    TOKENS.discard(token)
    return jsonify(ok=True)

# ---------------- Static files ----------------
ALLOWED_FILES = {'index.html', 'admin.html', 'IMG_9090.PNG', 'M.png'}

@app.route('/')
def index():
    return send_from_directory(APP_DIR, 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    if filename.split('/')[0] not in ALLOWED_FILES:
        abort(403)
    return send_from_directory(APP_DIR, filename)

if __name__ == '__main__':
    print('BioMed Hub خادم Python على: http://localhost:5000')
    app.run(host='0.0.0.0', port=5000, debug=False)