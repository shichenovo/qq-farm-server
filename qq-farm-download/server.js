#!/usr/bin/env node
'use strict';

// QQ Farm 下载站（替代裸 python http.server）
// 特性：
//  - 首次访问弹出「HTML 网页对话框」要求输入访问密码
//  - 密码后端校验，通过后种下 HttpOnly cookie（12h 有效，访问自动续期）
//  - 未验证前看不到任何文件列表 / 无法下载
//  - 密码默认 q20947154，可用环境变量 DOWNLOAD_PASSWORD 覆盖

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.DOWNLOAD_DIR || '/opt/downloads');
const PASSWORD = process.env.DOWNLOAD_PASSWORD || 'q20947154';
const COOKIE_NAME = 'qqfarm_dl';
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 小时

const sessions = new Map(); // token -> expiry(ms)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.tar': 'application/x-tar', '.gz': 'application/gzip', '.zip': 'application/zip',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

function genToken() { return crypto.randomBytes(24).toString('hex'); }

function isAuthed(req) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp(COOKIE_NAME + '=([0-9a-f]{48})'));
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || Date.now() > exp) { sessions.delete(m[1]); return false; }
  sessions.set(m[1], Date.now() + SESSION_TTL); // 续期
  return true;
}

function setAuthCookie(res) {
  const tok = genToken();
  sessions.set(tok, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${tok}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + ' ' + u[i];
}

// ---- 登录对话框页（未验证时展示） ----
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>QQ Farm 下载站 · 验证</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 50% -10%,#1e2b4d,#0b1020);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#e8edf7}
  .card{width:340px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
    border-radius:16px;padding:28px 26px;backdrop-filter:blur(10px);box-shadow:0 20px 60px rgba(0,0,0,.45)}
  h1{margin:0 0 4px;font-size:18px;font-weight:650}
  .sub{margin:0 0 20px;font-size:13px;color:#9fb0d0}
  label{display:block;font-size:12px;color:#9fb0d0;margin-bottom:6px}
  input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);
    background:rgba(0,0,0,.25);color:#fff;font-size:14px;outline:none}
  input:focus{border-color:#5b8cff}
  button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:10px;cursor:pointer;
    background:linear-gradient(135deg,#5b8cff,#7b5bff);color:#fff;font-size:15px;font-weight:600}
  button:disabled{opacity:.6;cursor:default}
  .err{margin-top:12px;font-size:13px;color:#ff7b7b;min-height:18px}
</style>
</head>
<body>
  <form class="card" id="form">
    <h1>QQ Farm 下载站</h1>
    <p class="sub">请输入访问密码以继续</p>
    <label for="pwd">访问密码</label>
    <input id="pwd" type="password" autocomplete="current-password" placeholder="请输入密码" autofocus/>
    <button id="btn" type="submit">验 证</button>
    <div class="err" id="err"></div>
  </form>
<script>
  var form=document.getElementById('form'),pwd=document.getElementById('pwd'),
    btn=document.getElementById('btn'),err=document.getElementById('err');
  form.addEventListener('submit',async function(e){
    e.preventDefault(); err.textContent=''; btn.disabled=true; btn.textContent='验证中…';
    try{
      var r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:pwd.value})});
      var data=await r.json();
      if(r.ok&&data.ok){ location.href='/'; }
      else { err.textContent=(data&&data.error)||'密码错误'; btn.disabled=false; btn.textContent='验 证'; }
    }catch(ev){ err.textContent='网络错误，请重试'; btn.disabled=false; btn.textContent='验 证'; }
  });
</script>
</body>
</html>`;

// ---- 已登录：目录列表页 ----
function renderDir(req, res, dirPath) {
  fs.readdir(dirPath, { withFileTypes: true }, (e, ents) => {
    if (e) return sendJson(res, 500, { ok: false, error: e.message });
    ents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    const relDir = path.relative(ROOT, dirPath); // 根目录为 ''
    const rows = ents.map((en) => {
      const isDir = en.isDirectory();
      const rel = (relDir ? relDir + '/' : '') + en.name;
      const href = '/' + rel.split('/').map(encodeURIComponent).join('/');
      const icon = isDir ? '📁' : '📄';
      return `<tr><td>${icon} <a class="name ${isDir ? 'dir' : ''}" href="${href}">` +
        `${escapeHtml(en.name)}${isDir ? '/' : ''}</a></td></tr>`;
    }).join('');
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>QQ Farm 下载站</title>
<style>
body{margin:0;background:#0b1020;color:#e8edf7;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;
  border-bottom:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
.topbar .t{font-weight:600;font-size:15px}
.topbar button{background:transparent;border:1px solid rgba(255,255,255,.2);color:#cdd7ee;
  padding:6px 12px;border-radius:8px;cursor:pointer}
.topbar button:hover{border-color:#5b8cff}
.wrap{max-width:880px;margin:24px auto;padding:0 16px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:12px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
th{color:#9fb0d0;font-weight:600;font-size:13px}
a.name{color:#cfe0ff;text-decoration:none}
a.name:hover{color:#5b8cff;text-decoration:underline}
a.dir{color:#ffd479}
.empty{color:#9fb0d0;padding:20px 0}
</style></head>
<body>
<div class="topbar"><span class="t">QQ Farm 下载站</span><button id="logout">退出登录</button></div>
<div class="wrap">
<table><thead><tr><th>文件 / 目录</th></tr></thead><tbody>${rows || '<tr><td class="empty">（空）</td></tr>'}</tbody></table>
</div>
<script>document.getElementById('logout').onclick=async function(){await fetch('/logout',{method:'POST'});location.href='/';};</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

function serveFile(req, res, real) {
  const ext = path.extname(real).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(real))}`,
  });
  fs.createReadStream(real).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/healthz') return sendJson(res, 200, { ok: true });

  if (p === '/login') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }
    return readBody(req).then((b) => {
      let pwd = '';
      try { pwd = (JSON.parse(b || '{}').password) || ''; } catch (_) {}
      if (pwd === PASSWORD) {
        setAuthCookie(res);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { ok: false, error: '密码错误' });
    }).catch(() => sendJson(res, 400, { ok: false, error: 'bad request' }));
  }

  if (p === '/logout') {
    const c = req.headers.cookie || '';
    const m = c.match(new RegExp(COOKIE_NAME + '=([0-9a-f]{48})'));
    if (m) sessions.delete(m[1]);
    clearAuthCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (!isAuthed(req)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  // 已认证：目录 / 文件
  const real = path.resolve(ROOT, '.' + p);
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.stat(real, (e, st) => {
    if (e) return sendJson(res, 404, { ok: false, error: 'not found' });
    if (st.isDirectory()) return renderDir(req, res, real);
    if (st.isFile()) return serveFile(req, res, real);
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[qq-farm-download] 监听 http://${HOST}:${PORT}`);
  console.log(`[qq-farm-download] 根目录: ${ROOT}`);
  console.log(`[qq-farm-download] 密码保护: 已开启（默认 q20947154，可用 DOWNLOAD_PASSWORD 覆盖）`);
});
