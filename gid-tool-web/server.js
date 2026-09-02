#!/usr/bin/env node
'use strict';

// 扫码取 Code 网页 —— 独立后端
// 仅做一件事：把浏览器的请求经 Unix Domain Socket 代理到 NapCat bridge，
// 不动任何现有农场bot/yyb-go 文件与运行中的服务。
// 浏览器 ──▶ 本服务(:8088) ──▶ /run/qqfarm-napcat-bridge/bridge.sock

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8099;
const HOST = process.env.HOST || '0.0.0.0';
const SOCKET_PATH =
  process.env.NAPCAT_BRIDGE_SOCKET || '/run/qqfarm-napcat-bridge/bridge.sock';
const PASSWORD = process.env.NAPCAT_CODE_WEB_PASSWORD || ''; // 空=不校验
const PUBLIC_DIR = path.join(__dirname, 'public');
const FARM_BOT_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';

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

function authorized(req) {
  if (!PASSWORD) return true;
  const url = new URL(req.url, 'http://x');
  const headerPwd = req.headers['x-auth-pwd'] || '';
  const qPwd = url.searchParams.get('pwd') || '';
  return headerPwd === PASSWORD || qPwd === PASSWORD;
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

// ============ 农场bot 好友 GID 代理 ============
// 复用农场bot 已暴露的只读 admin 接口（/api/friends、/api/friend-known-gids、
// /api/interact-records）。这些接口走农场bot 已过 ACE 加密的会话，
// 因此扫码网页无需复刻 nqf WS + WASM 加密栈，也完全不动农场bot 运行代码。
// 链路：访客接口(InteractRecords)产出 visitor_gid → 农场bot 直接当好友 GID →
// /api/friends 解析出 {gid,name,...}。本模块只做「带 token 转发 + 登录复用」。
const FARMBOT_ADMIN_URL = process.env.FARMBOT_ADMIN_URL || 'http://127.0.0.1:3010';
const FARMBOT_ADMIN_USER = process.env.FARMBOT_ADMIN_USER || 'admin';
const FARMBOT_ADMIN_PASSWORD = process.env.FARMBOT_ADMIN_PASSWORD || 'admin';
const FARMBOT_ACCOUNT_ID = process.env.FARMBOT_ACCOUNT_ID || '1';
let farmbotToken = '';

function farmbotRaw(apiPath, method, bodyBuf, accountId, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(FARMBOT_ADMIN_URL);
    } catch (e) {
      return resolve({ status: 502, data: { ok: false, error: '农场bot 地址无效: ' + FARMBOT_ADMIN_URL } });
    }
    const headers = { 'Content-Type': 'application/json' };
    if (farmbotToken) headers['x-admin-token'] = farmbotToken;
    if (accountId) headers['x-account-id'] = accountId;
    const opt = {
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: apiPath,
      headers,
      timeout: Number(timeoutMs) || 12000,
    };
    const r = http.request(opt, (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          data = { ok: false, error: '农场bot 响应解析失败' };
        }
        resolve({ status: upRes.statusCode, data });
      });
    });
    r.on('timeout', () => {
      r.destroy();
      resolve({ status: 504, data: { ok: false, error: '农场bot 响应超时' } });
    });
    r.on('error', (e) => resolve({ status: 502, data: { ok: false, error: '农场bot 连接失败: ' + e.message } }));
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

async function loginFarmbot() {
  const r = await farmbotRaw(
    '/api/login',
    'POST',
    Buffer.from(JSON.stringify({ username: FARMBOT_ADMIN_USER, password: FARMBOT_ADMIN_PASSWORD }))
  );
  if (!r.data || !r.data.ok || !r.data.data || !r.data.data.token)
    throw new Error('农场bot 登录失败: ' + ((r.data && (r.data.error || r.data.message)) || r.status));
  farmbotToken = r.data.data.token;
  return farmbotToken;
}

// 调用农场bot admin 接口；token 失效(401)时自动重登录并仅重试一次。
async function callFarmbot(apiPath, method, bodyBuf, accountId, timeoutMs) {
  if (!farmbotToken) {
    try {
      await loginFarmbot();
    } catch (e) {
      return { status: 502, data: { ok: false, error: e.message } };
    }
  }
  let r = await farmbotRaw(apiPath, method, bodyBuf, accountId, timeoutMs);
  if (r.status === 401) {
    farmbotToken = '';
    try {
      await loginFarmbot();
    } catch (e) {
      return { status: 502, data: { ok: false, error: e.message } };
    }
    r = await farmbotRaw(apiPath, method, bodyBuf, accountId, timeoutMs);
  }
  return r;
}

function proxyFarmbot(req, res) {
  const url = new URL(req.url, 'http://x');
  const sub = url.pathname.replace(/^\/api\/farmbot/, '') || '/';
  const accountId = url.searchParams.get('accountId') || FARMBOT_ACCOUNT_ID;
  // 农场bot 从请求头 x-account-id 读取账号（非 query），故从 query 中剔除后注入 header
  const sp = new URLSearchParams(url.searchParams);
  sp.delete('accountId');
  const query = sp.toString();
  const apiPath = '/api' + sub + (query ? '?' + query : '');
  const doReq = async (bodyBuf) => {
    const r = await callFarmbot(apiPath, req.method, bodyBuf, accountId);
    res.writeHead(r.status === 200 ? 200 : r.status || 500, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(r.data));
  };
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    readBody(req)
      .then((b) => doReq(Buffer.from(b)))
      .catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
  } else {
    doReq(null);
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

function readBodySafe(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', () => resolve(buf));
  });
}

// 用扫码拿到的「一次性 Code」直连游戏网关，登录后列出该 QQ 自己的游戏好友 gid。
// 以独立子进程运行 scan-gids.js，复用农场bot的 network.js（含 ACE/WASM 加解密），
// 与 3010 的 account 1 连接完全隔离，不新增账号、不影响农场bot运行。
function handleGetFriends(req, res) {
  // 直接从已登录 bot 账号的内存好友缓存取 gid（只读 /api/friends/cache，不触发任何游戏请求）。
  // 这正是「取已登录QQ好友gid」的正确来源——bot 自己连着网关、本来就在跑好友巡查。
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 GET/POST' });
  readBodySafe(req).then((raw) => {
    let accountId = (process.env.FARMBOT_ACCOUNT_ID || '1').toString().trim();
    let hideLv1 = true;
    let minKeepLevel = 0;
    let maxFilterLevel = 1;
    // 同时支持 GET query 与 POST body（前端 fetchGids 走 GET query）
    let qp = {};
    try { qp = Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch (_) {}
    try {
      const body = JSON.parse(raw || '{}');
      if (body.accountId) accountId = String(body.accountId).trim();
      if (body.hideLv1 === false) hideLv1 = false;
      const qMin = (qp.minKeepLevel !== undefined) ? qp.minKeepLevel : body.minKeepLevel;
      const qMax = (qp.maxFilterLevel !== undefined) ? qp.maxFilterLevel : body.maxFilterLevel;
      const maxExplicit = (qMax !== undefined && qMax !== null && qMax !== '');
      if (qMin !== undefined && qMin !== null && qMin !== '') {
        const n = Number(qMin); minKeepLevel = isNaN(n) ? 0 : Math.max(0, Math.floor(n));
      }
      if (maxExplicit) {
        const n = Number(qMax); maxFilterLevel = isNaN(n) ? 1 : Math.max(0, Math.floor(n));
      } else if (hideLv1) {
        maxFilterLevel = 1; // 未显式指定时, 沿用 hideLv1 复选框(默认过滤 Lv1)
      }
    } catch (_) {}
    callFarmbot('/api/friends/cache?accountId=' + encodeURIComponent(accountId), 'GET', null, accountId).then((r) => {
      const data = (r && r.data) || {};
      if (!r || r.status !== 200 || !data.ok) {
        return sendJson(res, r && r.status || 502, { ok: false, error: '读取 bot 好友缓存失败: ' + ((data && (data.error || data.message)) || r && r.status) });
      }
      const list = Array.isArray(data.data) ? data.data : [];
      const total = list.length;
      const kept = list.filter((f) => {
        const lv = toLv(f);
        return lv >= minKeepLevel && lv > maxFilterLevel;
      });
      const lv1Removed = total - kept.length;
      const gids = kept.map((f) => String(toGid(f))).filter((g) => g && g !== '0');
      const gidsText = gids.join(',');
      sendJson(res, 200, {
        ok: true,
        accountId,
        friends: kept.map((f) => ({ gid: String(toGid(f)), name: String(f.name || ''), level: toLv(f) })),
        count: kept.length,
        total,
        lv1Removed,
        hideLv1,
        minKeepLevel,
        maxFilterLevel,
        gidsText,
      });
    }).catch((e) => sendJson(res, 502, { ok: false, error: '调用 bot 失败: ' + (e && e.message ? e.message : e) }));
  });
}

// 取 gid：兼容 number / string / bigint / {low,high}
function toGid(f) {
  const g = f && (f.gid != null ? f.gid : f.g_id);
  if (g == null) return 0;
  if (typeof g === 'number') return g;
  if (typeof g === 'bigint') return Number(g);
  if (typeof g === 'string') { const n = Number(g); return isNaN(n) ? 0 : n; }
  if (g && typeof g.low === 'number') return g.low >>> 0; // 兜底
  return 0;
}
// 解锁：恢复 bot 自动合并同步（允许新发现/被过滤好友重新纳入）。调用 bot 的 /api/friend-known-gids/unlock。
function handleUnlockFriends(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
  readBodySafe(req).then((raw) => {
    let accountId = (process.env.FARMBOT_ACCOUNT_ID || '1').toString().trim();
    try {
      const body = JSON.parse(raw || '{}');
      if (body.accountId) accountId = String(body.accountId).trim();
    } catch (_) {}
    callFarmbot('/api/friend-known-gids/unlock?accountId=' + encodeURIComponent(accountId), 'POST',
      Buffer.from(JSON.stringify({})), accountId).then((r) => {
      const data = (r && r.data) || {};
      if (!r || r.status !== 200 || !data.ok) {
        return sendJson(res, r && r.status || 502, { ok: false, error: '解锁失败: ' + ((data && (data.error || data.message)) || r && r.status) });
      }
      sendJson(res, 200, { ok: true, accountId, manualLock: !!(data.data && data.data.knownFriendGidsManualLock) });
    }).catch((e) => sendJson(res, 502, { ok: false, error: '调用 bot 失败: ' + (e && e.message ? e.message : e) }));
  });
}


// ============ 微信(YYB)扫码登录 —— 直连本机 yyb-go(:8450) ============
// 走 yyb-go 的 /qr 体系：扫码确认后 login_buffer 写回 yyb.db(alive)，
// 之后 bot 的 worker 会自动向 yyb-go 换码，账号3(loginType:yyb) 自动上线。
const YYB_API_URL = process.env.YYB_API_URL || 'http://127.0.0.1:8450';
const YYB_API_KEY = process.env.YYB_API_KEY || 'REPLACE_WITH_YOUR_YYB_TOKEN';
const YYB_WX_APP_ID = process.env.YYB_WX_APP_ID || 'wx5306c5978fdb76e4';

function yybRequest(apiPath, method, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(YYB_API_URL); } catch (e) { return reject(new Error('yyb-go 地址无效: ' + YYB_API_URL)); }
    const data = bodyObj ? JSON.stringify(bodyObj) : '';
    const opt = {
      method: method.toUpperCase(),
      hostname: u.hostname,
      port: u.port || 80,
      path: apiPath,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + YYB_API_KEY,
      },
      timeout: Number(timeoutMs) || 60000,
    };
    if (data) opt.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(opt, (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        let raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { json = null; }
        const body = (json && typeof json.data !== 'undefined') ? json.data : json;
        resolve({ status: upRes.statusCode, code: json && json.code, msg: json && json.msg, body, raw: json });
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('yyb-go 响应超时')); });
    r.on('error', (e) => reject(new Error('yyb-go 连接失败: ' + e.message)));
    if (data) r.write(data);
    r.end();
  });
}

// 获取微信(YYB)登录二维码：直连 yyb-go /qr，返回 base64 图片
async function handleWxLoginQr(req, res) {
  try {
    const r = await yybRequest('/qr?as_base64=true', 'POST', null, 60000);
    const inner = r.body || {};
    const sessionId = String(inner.session_id || '').trim();
    const imageBase64 = inner.image_base64 || '';
    if (!sessionId || !imageBase64) {
      return sendJson(res, 502, { ok: false, error: 'YYB 创建二维码失败: ' + (r.msg || r.status) });
    }
    sendJson(res, 200, {
      ok: true,
      taskId: sessionId,
      image: imageBase64.indexOf('data:') === 0 ? imageBase64 : 'data:image/jpeg;base64,' + imageBase64,
      status: inner.status || 'pending',
    });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: '调用 yyb-go 失败: ' + (e && e.message ? e.message : e) });
  }
}

// 轮询扫码状态
async function handleWxLoginStatus(req, res) {
  const url = new URL(req.url, 'http://x');
  const taskId = url.searchParams.get('taskId') || '';
  if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 taskId' });
  try {
    const r = await yybRequest('/qr/' + encodeURIComponent(taskId) + '/poll', 'GET', null, 25000);
    const inner = r.body || {};
    sendJson(res, 200, {
      ok: true,
      taskId,
      status: inner.status || 'pending',
      openid: inner.openid || '',
    });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: '调用 yyb-go 失败: ' + (e && e.message ? e.message : e) });
  }
}

// 确认登录：直连 yyb-go /qr/:id/confirm，刷新 login_buffer；随后启动账号3(loginType:yyb 自动换码)
async function handleWxLoginConfirm(req, res) {
  const url = new URL(req.url, 'http://x');
  const taskId = url.searchParams.get('taskId') || '';
  let accountId = (process.env.FARMBOT_ACCOUNT_ID || '3').toString().trim();
  if (url.searchParams.get('accountId')) accountId = url.searchParams.get('accountId').trim();
  if (!taskId) return sendJson(res, 400, { ok: false, error: '缺少 taskId' });
  try {
    // 1) 确认扫码会话 → yyb-go 把 login_buffer 存入 yyb.db(状态 alive)
    const cr = await yybRequest('/qr/' + encodeURIComponent(taskId) + '/confirm', 'POST', null, 30000);
    const cdata = cr.body || {};
    const openid = String(cdata.openid || '').trim();
    if (!openid) {
      return sendJson(res, 502, { ok: false, error: 'YYB 确认登录失败（未返回 openid）: ' + (cr.msg || cr.status) });
    }
    // 2) 校验 login_buffer 是否已被刷新为 alive
    let bufferAlive = false;
    try {
      const gr = await yybRequest('/accounts', 'GET', null, 20000);
      const list = (gr.body && Array.isArray(gr.body)) ? gr.body : [];
      const me = list.find((a) => String(a.openid) === openid);
      bufferAlive = !!(me && me.status === 'alive');
    } catch (_) {}
    if (!bufferAlive) {
      return sendJson(res, 502, { ok: false, error: 'login_buffer 未刷新为 alive，请重试扫码确认' });
    }
    // 3) 确保账号3 为 loginType:yyb + 正确的 yybOpenid（让 worker 自动换码）
    let name = '沉稳🛫';
    try {
      const gr = await callFarmbot('/api/accounts', 'GET', null, accountId);
      const gdata = (gr && gr.data) || {};
      const accs = (gdata.data && gdata.data.accounts) || gdata.accounts || (Array.isArray(gdata) ? gdata : []);
      const me = accs.find((a) => String(a.id) === String(accountId));
      if (me && me.name) name = me.name;
    } catch (_) {}
    const saveBody = JSON.stringify({
      id: accountId,
      name,
      platform: 'wx',
      loginType: 'yyb',
      yybOpenid: openid,
      openid: openid,
      wxid: openid,
    });
    const sr = await callFarmbot('/api/accounts', 'POST', Buffer.from(saveBody), accountId);
    const sdata = (sr && sr.data) || {};
    if (!sr || sr.status !== 200 || !sdata.ok) {
      return sendJson(res, sr && sr.status || 502, { ok: false, error: '写回账号失败: ' + ((sdata && (sdata.error || sdata.message)) || sr && sr.status) });
    }
    // 4) 启动账号（worker 的 refreshYybCodeIfNeeded 会自动向 yyb-go 换新 Code）
    const st = await callFarmbot('/api/accounts/' + encodeURIComponent(accountId) + '/start', 'POST', Buffer.from('{}'), accountId);
    const stData = (st && st.data) || {};
    sendJson(res, 200, {
      ok: true,
      accountId,
      openid,
      bufferAlive: true,
      saved: true,
      started: !!(stData.ok),
      startMsg: stData.error || '',
    });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: '调用失败: ' + (e && e.message ? e.message : e) });
  }
}
async function callFarmbotRawBytes(apiPath, method, accountId) {
  return new Promise((resolve) => {
    if (!farmbotToken) { try { /* token 已在 callFarmbot 内保证 */ } catch (_) {} }
    const doReq = async () => {
      if (!farmbotToken) { try { await loginFarmbot(); } catch (e) { return resolve({ ok: false }); } }
      let u; try { u = new URL(FARMBOT_ADMIN_URL); } catch (e) { return resolve({ ok: false }); }
      const headers = { 'Content-Type': 'application/json' };
      if (farmbotToken) headers['x-admin-token'] = farmbotToken;
      if (accountId) headers['x-account-id'] = accountId;
      const opt = { method, hostname: u.hostname, port: u.port || 80, path: apiPath, headers, timeout: 20000 };
      const r = http.request(opt, (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => resolve({ ok: upRes.statusCode === 200, buf: Buffer.concat(chunks), status: upRes.statusCode }));
      });
      r.on('timeout', () => { r.destroy(); resolve({ ok: false }); });
      r.on('error', () => resolve({ ok: false }));
      r.end();
    };
    doReq();
  });
}


function toLv(f) {
  const v = f && (f.level != null ? f.level : 0);
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// 把过滤后的好友 gid 列表整体替换进 bot 的 knownFriendGids 配置（账号按 accountId）。
// 调用 bot 的 POST /api/friend-known-gids?accountId=X，body.knownFriendGids = gids[]。
function handleReplaceFriends(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
  readBodySafe(req).then((raw) => {
    let accountId = (process.env.FARMBOT_ACCOUNT_ID || '1').toString().trim();
    let gids = [];
    let hideLv1 = true;
    let minKeepLevel = 0;
    let maxFilterLevel = 1;
    try {
      const body = JSON.parse(raw || '{}');
      if (body.accountId) accountId = String(body.accountId).trim();
      if (Array.isArray(body.gids)) gids = body.gids;
      if (body.hideLv1 === false) hideLv1 = false;
      if (body.minKeepLevel !== undefined && body.minKeepLevel !== null && body.minKeepLevel !== '') {
        const n = Number(body.minKeepLevel); minKeepLevel = isNaN(n) ? 0 : Math.max(0, Math.floor(n));
      }
      if (body.maxFilterLevel !== undefined && body.maxFilterLevel !== null && body.maxFilterLevel !== '') {
        const n = Number(body.maxFilterLevel); maxFilterLevel = isNaN(n) ? 1 : Math.max(0, Math.floor(n));
      }
      if (hideLv1) maxFilterLevel = 1;
    } catch (_) {}
    if (!Array.isArray(gids) || gids.length === 0) {
      return sendJson(res, 400, { ok: false, error: '缺少待写入的 gid 列表' });
    }
    // 规范化 + 过滤 Lv1（与读取时一致），并去重
    const seen = new Set();
    const norm = [];
    for (const g of gids) {
      const n = Number(g);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (hideLv1 && (g.level !== undefined ? Number(g.level) <= 1 : false)) continue; // 前端已过滤，这里兜底
      if (seen.has(n)) continue;
      seen.add(n); norm.push(n);
    }
    if (norm.length === 0) return sendJson(res, 400, { ok: false, error: '有效 gid 为空' });
    callFarmbot('/api/friend-known-gids?accountId=' + encodeURIComponent(accountId), 'POST',
      Buffer.from(JSON.stringify({ knownFriendGids: norm })), accountId).then((r) => {
      const data = (r && r.data) || {};
      if (!r || r.status !== 200 || !data.ok) {
        return sendJson(res, r && r.status || 502, { ok: false, error: '写入 bot 失败: ' + ((data && (data.error || data.message)) || r && r.status) });
      }
      const newCount = (data.data && data.data.knownFriendGids ? data.data.knownFriendGids.length : norm.length);
      sendJson(res, 200, { ok: true, accountId, written: norm.length, newCount });
    }).catch((e) => sendJson(res, 502, { ok: false, error: '调用 bot 失败: ' + (e && e.message ? e.message : e) }));
  });
}

function toLv(f) {
  const v = f && (f.level != null ? f.level : 0);
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (!authorized(req))
    return sendJson(res, 403, { ok: false, error: '需要密码', needAuth: true });
  if (url.pathname.startsWith('/api/bridge')) return proxyBridge(req, res);
  if (url.pathname.startsWith('/api/farmbot')) return proxyFarmbot(req, res);
  if (url.pathname === '/api/friends') return handleGetFriends(req, res);
  if (url.pathname === '/api/friends/replace') return handleReplaceFriends(req, res);
  if (url.pathname === '/api/friends/unlock') return handleUnlockFriends(req, res);
  if (url.pathname === '/api/wx-login/qr') return handleWxLoginQr(req, res);
  if (url.pathname === '/api/wx-login/status') return handleWxLoginStatus(req, res);
  if (url.pathname === '/api/wx-login/confirm') return handleWxLoginConfirm(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[gid-tool-web] 监听 http://${HOST}:${PORT}`);
  console.log(`[gid-tool-web] 代理到 bridge socket: ${SOCKET_PATH}`);
  console.log(
    `[gid-tool-web] 密码保护: ${PASSWORD ? '已开启' : '未开启（设 NAPCAT_CODE_WEB_PASSWORD 即可开启）'}`
  );
});
