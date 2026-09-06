"use strict";
/**
 * link-ops：面板手动管理的「定时访问 URL」功能（保活隧道/长链链接）。
 *
 * - 数据文件：core/data/link_ops.json（中性命名，不显眼）
 * - API 统一挂在 /api/link-ops* 下，自动受现有 /api 管理员鉴权保护
 * - 常驻 tick（5 秒）扫描任务是否到期，到期间异步 GET（超时 15s）
 * - 仅失败时输出 warn 日志，正常运行不刷日志；最近结果写回数据文件
 *
 * 服务器定制模块：升级走 3-way merge，本文件需保留（镜像同步至 custom-modules）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const DATA_DIR = path.join(__dirname, '../../../data');
const DATA_FILE = path.join(DATA_DIR, 'link_ops.json');

const TICK_MS = 5000;
const REQ_TIMEOUT_MS = 15000;
const DEFAULT_INTERVAL_SEC = 300; // 默认 5 分钟，与旧 cron 节奏一致
const MIN_INTERVAL_SEC = 60;

let tasks = [];
let startedAt = 0;
let tickTimer = null;

// ---------------- 持久化 ----------------

function load() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (Array.isArray(raw.tasks)) tasks = raw.tasks;
            if (typeof raw.startedAt === 'number') startedAt = raw.startedAt;
        }
    } catch (e) {
        console.warn('[link-ops] load failed:', e.message);
    }
}

function save() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2), 'utf8');
        fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
        console.warn('[link-ops] save failed:', e.message);
    }
}

// ---------------- 任务执行 ----------------

function fetchUrl(url, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try {
            u = new URL(url);
        } catch (_) {
            return resolve({ code: 0, ms: 0, error: '无效 URL' });
        }
        const mod = u.protocol === 'https:' ? https : (u.protocol === 'http:' ? http : null);
        if (!mod) return resolve({ code: 0, ms: 0, error: '仅支持 http/https' });
        const started = Date.now();
        const req = mod.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            res.resume();
            resolve({ code: res.statusCode || 0, ms: Date.now() - started, error: '' });
        });
        req.on('timeout', () => {
            try { req.destroy(); } catch (_) {}
            resolve({ code: 0, ms: Date.now() - started, error: '超时' });
        });
        req.on('error', (e) => resolve({ code: 0, ms: Date.now() - started, error: String(e.message || e).slice(0, 120) }));
    });
}

async function runTask(task, manual) {
    const r = await fetchUrl(task.url, REQ_TIMEOUT_MS);
    task.lastRun = Date.now();
    task.lastCode = r.code;
    task.lastMs = r.ms;
    task.lastError = r.error || '';
    if (r.code === 0 || r.code >= 500) {
        console.warn(`[link-ops] ${manual ? 'manual' : 'auto'} ${task.url} -> ${r.error || ('HTTP ' + r.code)}`);
    }
    save();
    return r;
}

function tick() {
    const now = Date.now();
    for (const t of tasks) {
        if (!t.enabled) continue;
        const intervalMs = Math.max(MIN_INTERVAL_SEC, Number(t.intervalSec) || DEFAULT_INTERVAL_SEC) * 1000;
        if (now - (t.lastRun || 0) >= intervalMs) {
            runTask(t, false);
        }
    }
}

function ensureTimer() {
    if (tickTimer) return;
    startedAt = Date.now();
    tickTimer = setInterval(tick, TICK_MS);
    if (tickTimer.unref) tickTimer.unref();
}

// ---------------- 路由 ----------------

function mountLinkOpsRoutes(app, ctx) {
    load();
    ensureTimer();

    // 列表 + 状态
    app.get('/api/link-ops', (_req, res) => {
        res.json({ ok: true, data: { tasks, startedAt, tickMs: TICK_MS } });
    });

    // 添加任务
    app.post('/api/link-ops', (req, res) => {
        const url = String((req.body || {}).url || '').trim();
        if (!/^https?:\/\/.+/i.test(url)) {
            return res.status(400).json({ ok: false, error: 'URL 无效，需以 http(s):// 开头' });
        }
        const intervalSec = Math.max(MIN_INTERVAL_SEC, Number((req.body || {}).intervalSec) || DEFAULT_INTERVAL_SEC);
        const task = {
            id: String(Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
            url,
            intervalSec,
            enabled: true,
            lastRun: 0,
            lastCode: 0,
            lastMs: 0,
            lastError: '',
            createdAt: Date.now(),
        };
        tasks.push(task);
        save();
        res.json({ ok: true, data: task });
    });

    // 删除任务
    app.post('/api/link-ops/remove', (req, res) => {
        const id = String((req.body || {}).id || '');
        const before = tasks.length;
        tasks = tasks.filter((t) => t.id !== id);
        if (tasks.length === before) {
            return res.status(404).json({ ok: false, error: '任务不存在' });
        }
        save();
        res.json({ ok: true });
    });

    // 启用/停用
    app.post('/api/link-ops/toggle', (req, res) => {
        const id = String((req.body || {}).id || '');
        const enabled = !!(req.body || {}).enabled;
        const t = tasks.find((x) => x.id === id);
        if (!t) return res.status(404).json({ ok: false, error: '任务不存在' });
        t.enabled = enabled;
        if (enabled) t.lastRun = 0; // 开启后立即进入下一轮
        save();
        res.json({ ok: true, data: t });
    });

    // 立即测试（不落任务，仅返回结果）
    app.post('/api/link-ops/test', async (req, res) => {
        const url = String((req.body || {}).url || '').trim();
        if (!/^https?:\/\/.+/i.test(url)) {
            return res.status(400).json({ ok: false, error: 'URL 无效' });
        }
        try {
            const r = await fetchUrl(url, REQ_TIMEOUT_MS);
            res.json({ ok: true, data: r });
        } catch (e) {
            res.status(500).json({ ok: false, error: String(e.message || e) });
        }
    });
}

module.exports = { mountLinkOpsRoutes };
