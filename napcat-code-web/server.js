#!/usr/bin/env node
'use strict';

// 扫码取 Code 网页 —— 独立后端（「只显示 Code」精简版）
// 仅做一件事：把浏览器的请求经 Unix Domain Socket 代理到 NapCat bridge，
// 不动任何现有农场bot/yyb-go 文件与运行中的服务。
// 浏览器 ──▶ 本服务(:8088) ──▶ /run/qqfarm-napcat-bridge/bridge.sock
//
// 本版本不含「好友 GID 提取（scan-gids）」逻辑，只负责：扫码 → 取一次性授权码 → 展示/复制。
// 带 GID 提取的完整版本已备份在 /opt/napcat-code-web.bak.scan-gids.* 。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8088;
const HOST = process.env.HOST || '0.0.0.0';
const SOCKET_PATH =
  process.env.NAPCAT_BRIDGE_SOCKET || '/run/qqfarm-napcat-bridge/bridge.sock';
const PASSWORD = process.env.NAPCAT_CODE_WEB_PASSWORD || ''; // 空=不校验
const PUBLIC_DIR = path.join(__dirname, 'public');

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (!authorized(req))
    return sendJson(res, 403, { ok: false, error: '需要密码', needAuth: true });
  if (url.pathname.startsWith('/api/bridge')) return proxyBridge(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[napcat-code-web] 监听 http://${HOST}:${PORT}`);
  console.log(`[napcat-code-web] 代理到 bridge socket: ${SOCKET_PATH}`);
  console.log(
    `[napcat-code-web] 密码保护: ${PASSWORD ? '已开启' : '未开启（设 NAPCAT_CODE_WEB_PASSWORD 即可开启）'}`
  );
});
