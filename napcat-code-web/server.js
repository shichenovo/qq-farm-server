#!/usr/bin/env node
'use strict';

// 扫码取 Code 网页 —— 独立后端（「只显示 Code」精简版）
// 仅做一件事：把浏览器的请求经 Unix Domain Socket 代理到 NapCat bridge，
// 不动任何现有农场bot/yyb-go 文件与运行中的服务。
// 浏览器 ──▶ 本服务(:8088) ──▶ /run/qqfarm-napcat-bridge/bridge.sock
//
// 本版本不含「好友 GID 提取（scan-gids）」逻辑，只负责：扫码 → 取一次性授权码 → 展示/复制。
// 带 GID 提取的完整版本已备份在 /opt/napcat-code-web.bak.scan-gids.* 。
//
// === 密码验证（对话框）===
// 默认支持两种校验方式（PASSWORD 来自 NAPCAT_CODE_WEB_PASSWORD，空=不校验）：
//   1) 兼容旧方式：请求带 x-auth-pwd 请求头，或 ?pwd= 查询参数；
//   2) HTML 对话框登录：未认证访问页面 -> 返回整页登录页，输入密码后下发
//      HttpOnly Cookie 会话（12h，访问自动续期），刷新/重开免重复输入。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// 用一次性 Code 直连游戏网关拉取全部好友 GID（复用农场 bot 的 network.js / ACE-WASM）
const SCAN_GIDS_SCRIPT = path.join(__dirname, 'scan-gids.js');
const FARM_BOT_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';

const PORT = Number(process.env.PORT) || 8088;
const HOST = process.env.HOST || '0.0.0.0';
const SOCKET_PATH =
  process.env.NAPCAT_BRIDGE_SOCKET || '/run/qqfarm-napcat-bridge/bridge.sock';
const PASSWORD = process.env.NAPCAT_CODE_WEB_PASSWORD || ''; // 空=不校验
const PUBLIC_DIR = path.join(__dirname, 'public');

// ===== Cookie 会话 =====
const COOKIE_NAME = 'nccw_sid';
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 小时
const sessions = new Map(); // token -> expiry(ms)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

// 主认证方式：Cookie 会话。未设密码(PW 为空)时始终放行。
function isAuthed(req) {
  if (!PASSWORD) return true;
  const m = (req.headers.cookie || '').match(new RegExp(COOKIE_NAME + '=([0-9a-f]{48})'));
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || Date.now() > exp) {
    sessions.delete(m[1]);
    return false;
  }
  sessions.set(m[1], Date.now() + SESSION_TTL); // 续期
  return true;
}

// 兼容旧方式：x-auth-pwd 请求头 / ?pwd= 查询参数。
function headerAuthorized(req) {
  if (!PASSWORD) return true;
  const url = new URL(req.url, 'http://x');
  const headerPwd = req.headers['x-auth-pwd'] || '';
  const qPwd = url.searchParams.get('pwd') || '';
  return headerPwd === PASSWORD || qPwd === PASSWORD;
}

function setAuthCookie(res) {
  const tok = genToken();
  sessions.set(tok, Date.now() + SESSION_TTL);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${tok}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}; SameSite=Lax`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ===== HTML 登录对话框（整页）=====
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>扫码取 Code · 访问控制</title>
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
    <h1>扫码取 Code 网页</h1>
    <p class="sub">请输入访问密码以继续</p>
    <label for="pwd">访问密码</label>
    <input id="pwd" type="password" autocomplete="current-password" placeholder="请输入密码" autofocus/>
    <button id="btn" type="submit">验 证</button>
    <div class="err" id="err"></div>
  </form>
<script>
  const form=document.getElementById('form'),pwd=document.getElementById('pwd'),
    btn=document.getElementById('btn'),err=document.getElementById('err');
  form.addEventListener('submit',async e=>{
    e.preventDefault(); err.textContent=''; btn.disabled=true; btn.textContent='验证中…';
    try{
      const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:pwd.value})});
      const data=await r.json().catch(()=>({}));
      if(r.ok&&data.ok){ location.href='/'; }
      else { err.textContent=data.error||'密码错误'; btn.disabled=false; btn.textContent='验 证'; }
    }catch(e){ err.textContent='网络错误，请重试'; btn.disabled=false; btn.textContent='验 证'; }
  });
</script>
</body>
</html>`;

function proxyBridge(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/api\/bridge/, '') || '/';
  const targetPath = p + url.search;

  const doRequest = (bodyBuf) => {
    const options = {
      socketPath: SOCKET_PATH,
      method: req.method,
      path: targetPath,
      headers: { ...req.headers, host: 'localhost' },
    };
    delete options.headers['content-length'];
    delete options.headers['connection'];
    const r = http.request(options, (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        res.writeHead(upRes.statusCode, upRes.headers);
        res.end(Buffer.concat(chunks));
      });
    });
    r.on('error', (e) =>
      sendJson(res, 502, {
        ok: false,
        error: 'bridge 连接失败: ' + e.message,
        socket: SOCKET_PATH,
      })
    );
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  };

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    readBody(req)
      .then((b) => doRequest(Buffer.from(b)))
      .catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
  } else {
    doRequest(null);
  }
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(p));
  if (!fp.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  fs.readFile(fp, (err, data) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found' });
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// 用扫码拿到的「一次性 Code」直连游戏网关，拉取该 QQ 自己的全部游戏好友 GID。
// 以独立子进程运行 scan-gids.js，与 3010 的账号连接完全隔离。
// 子进程把结果写到临时文件，绕开 farm-bot 日志对 stdout 的污染。
function handleScanGids(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
  readBody(req).then((raw) => {
    let code = '';
    let seedGids = '';
    try {
      const body = JSON.parse(raw || '{}');
      code = (body.code || '').toString().trim();
      seedGids = (body.seedGids || '').toString().trim();
    } catch (_) {}
    if (!code) return sendJson(res, 400, { ok: false, error: '缺少 code' });

    const outPath = `/tmp/scan-gids-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    const child = spawn(process.execPath, [SCAN_GIDS_SCRIPT], {
      env: Object.assign({}, process.env, {
        SCAN_CODE: code,
        FARM_BOT_DIST: FARM_BOT_DIST,
        SCAN_RESULT_FILE: outPath,
        SCAN_GIDS_TIMEOUT: '42000',
        SEED_GIDS: seedGids,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errOut = '';
    child.stderr.on('data', (d) => (errOut += d));
    const cleanupFile = () => { try { fs.unlinkSync(outPath); } catch (_) {} };
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      cleanupFile();
      sendJson(res, 504, { ok: false, error: '取好友超时（网关无响应，Code 可能已失效）' });
    }, 50000);
    child.on('close', () => {
      clearTimeout(killTimer);
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) {}
      cleanupFile();
      if (parsed && parsed.ok) return sendJson(res, 200, parsed);
      if (parsed) return sendJson(res, 502, parsed);
      sendJson(res, 502, { ok: false, error: '网关子进程异常：' + (errOut || '无输出').slice(0, 300) });
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return sendJson(res, 200, { ok: true });

  // 登录页 / 登录接口
  if (p === '/login') {
    if (req.method === 'GET') {
      if (isAuthed(req)) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }
    if (req.method === 'POST') {
      readBody(req)
        .then((b) => {
          let pwd = '';
          try {
            pwd = (JSON.parse(b || '{}').password) || '';
          } catch (_) {}
          if (pwd === PASSWORD) {
            setAuthCookie(res);
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 401, { ok: false, error: '密码错误' });
        })
        .catch(() => sendJson(res, 400, { ok: false, error: 'bad request' }));
      return;
    }
  }

  // 登出
  if (p === '/logout' && req.method === 'POST') {
    const m = (req.headers.cookie || '').match(new RegExp(COOKIE_NAME + '=([0-9a-f]{48})'));
    if (m) sessions.delete(m[1]);
    clearAuthCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // 统一认证：Cookie 优先，兼容旧 header/pwd 方式
  if (!isAuthed(req) && !headerAuthorized(req)) {
    if (p.startsWith('/api/bridge')) {
      return sendJson(res, 403, { ok: false, error: '需要登录', needAuth: true });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  if (p.startsWith('/api/bridge')) return proxyBridge(req, res);
  if (p === '/api/scan-gids') return handleScanGids(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[napcat-code-web] 监听 http://${HOST}:${PORT}`);
  console.log(`[napcat-code-web] 代理到 bridge socket: ${SOCKET_PATH}`);
  console.log(
    `[napcat-code-web] 密码保护: ${
      PASSWORD
        ? '已开启（HTML 对话框登录 + HttpOnly Cookie 会话）'
        : '未开启（设 NAPCAT_CODE_WEB_PASSWORD 即可开启）'
    }`
  );
});
