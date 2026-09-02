"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 微信应用宝(YYB)扫码登录代理路由
 * 前端面板原有的"微信扫码登录"改走这里，调用本机 yyb-go 服务(:8450)。
 */
const http = require('node:http');
const { createAuthRequired } = require('./middleware');

const YYB_API_URL = process.env.YYB_API_URL || 'http://127.0.0.1:8450';
const YYB_API_KEY = process.env.YYB_API_KEY || '';

function yybRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, YYB_API_URL);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(YYB_API_KEY ? { 'Authorization': `Bearer ${YYB_API_KEY}` } : {}),
      },
      timeout: 60_000,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          // 兼容 {code,msg,data} 包装与裸对象两种返回
          const unwrapped = (json && typeof json.data !== 'undefined') ? json.data
            : (json && json.code === undefined && json.msg === undefined) ? json
            : null;
          resolve({ status: res.statusCode, body: unwrapped, raw: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: null, raw: { error: chunks } });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('yyb request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function mountYybWxRoutes(app, ctx) {
  app.use('/api/wx-yyb', createAuthRequired(ctx));

  // 创建扫码会话
  app.post('/api/wx-yyb/qr', async (req, res) => {
    try {
      const result = await yybRequest('/qr?as_base64=true', 'POST');
      const inner = result.body || {};
      const sessionId = String(inner.session_id || '').trim();
      const imageBase64 = inner.image_base64;
      if (!sessionId || !imageBase64) {
        return res.status(502).json({ ok: false, error: 'YYB 创建二维码失败' });
      }
      res.json({
        ok: true,
        data: {
          task_id: sessionId,
          app_id: 'wx5306c5978fdb76e4',
          status: inner.status || 'pending',
          qr_url: inner.image_url,
          image_base64: imageBase64,
        }
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  // 轮询扫码状态
  app.get('/api/wx-yyb/qr/:taskId/poll', async (req, res) => {
    try {
      const result = await yybRequest(`/qr/${req.params.taskId}/poll`, 'GET');
      const inner = result.body || {};
      const status = inner.status || 'pending';
      res.json({
        ok: true,
        data: {
          task_id: req.params.taskId,
          app_id: 'wx5306c5978fdb76e4',
          status: status,
          ...(inner.openid ? { openid: inner.openid } : {}),
        }
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  // 确认登录，返回账号信息
  app.post('/api/wx-yyb/qr/:taskId/confirm', async (req, res) => {
    try {
      const result = await yybRequest(`/qr/${req.params.taskId}/confirm`, 'POST');
      const inner = result.body || {};
      const openid = String(inner.openid || '').trim();
      if (!openid) {
        return res.status(502).json({ ok: false, error: 'YYB 确认登录失败（未返回 openid）' });
      }
      res.json({
        ok: true,
        data: {
          task_id: req.params.taskId,
          app_id: 'wx5306c5978fdb76e4',
          status: 'authorized',
          openid: openid,
          uin: inner.uin,
          nickname: inner.nickname,
        }
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { mountYybWxRoutes };
