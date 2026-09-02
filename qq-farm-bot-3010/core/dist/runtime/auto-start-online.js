"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fetch = require('node-fetch');
const { checkNapCatBridge } = require('../services/napcat-bridge-client');
const { createScheduler } = require('../services/scheduler');
/**
 * 「在线自动挂机」巡检服务  [新增 2026-09-02]
 *
 * 需求：检测到 QQ（NapCat 桥接）或应用宝（微信 YYB）在线时，如果对应账号的 bot 没在运行，
 *       就自动拉起挂机；已经在运行的绝不重复拉起，否则会互相打死形成死循环。
 *
 * 防死循环四道闸（缺一不可）：
 *   闸 1  isAccountRunning() 前置判断 —— workers 里还有这个账号的进程就一律不动。
 *         这是最核心的一条，直接掐掉「在线 + 已运行 → 又启动」的循环。
 *   闸 2  pending 集合 —— startWorker 是异步的（内部要 await 刷新 Code，可能耗时数十秒），
 *         上一次调用没返回前不允许再进，避免同一账号并发 fork 出两个 worker。
 *   闸 3  冷却期 —— 一次启动尝试结束后静默 90 秒。主要用来和 worker-manager 的
 *         scheduleReconnect 错开，防止两套自动拉起逻辑互相点火。
 *   闸 4  失败指数退避 —— 连续失败按 2/4/8/16…分钟退避，上限 30 分钟。
 *         NapCat 或应用宝真的挂掉时，不会每秒刷一遍日志和 Code。
 *
 * 本服务只负责「启动」，绝不主动 stop；账号该不该停由用户或离线重连逻辑决定。
 */
const DEFAULT_INTERVAL_MINUTES = 2;
const COOLDOWN_MS = 90 * 1000;              // 每次启动尝试后的静默期
const BASE_BACKOFF_MS = 2 * 60 * 1000;      // 失败退避基数
const MAX_BACKOFF_MS = 30 * 60 * 1000;      // 失败退避上限
const OFFLINE_LOG_THROTTLE_MS = 10 * 60 * 1000; // 离线提示的日志节流
function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
function createAutoStartOnlineService(deps) {
    const { store, getAccounts, isAccountRunning, resolveWorkerControls, log, addAccountLog, } = deps;
    const scheduler = createScheduler('auto_start_online');
    const TASK = 'watchdog';
    const pending = new Set();           // 闸 2：正在启动中的账号 id
    const nextAttemptAt = new Map();     // 闸 3+4：accountId -> 下次允许启动的时间戳
    const failCount = new Map();         // 闸 4：accountId -> 连续失败次数
    const offlineLoggedAt = new Map();   // offline 日志节流
    let ticking = false;
    // 配置优先级：环境变量 > store 系统配置 > 默认值。
    // 走环境变量是因为面板保存系统配置时会整体覆盖 systemConfig，写在那儿容易丢。
    function getConfig() {
        const sys = (typeof store.getSystemConfig === 'function' && store.getSystemConfig()) || {};
        const cfg = (sys && sys.autoStartOnline) || {};
        const envEnabled = String(process.env.FARM_AUTO_START_ONLINE || '').trim();
        const envInterval = String(process.env.FARM_AUTO_START_INTERVAL_MIN || '').trim();
        let enabled = cfg.enabled !== false;
        if (envEnabled === '0' || envEnabled.toLowerCase() === 'false')
            enabled = false;
        else if (envEnabled === '1' || envEnabled.toLowerCase() === 'true')
            enabled = true;
        return {
            enabled,
            intervalMinutes: clampInt(envInterval || cfg.intervalMinutes, 1, 60, DEFAULT_INTERVAL_MINUTES),
            excludeAccountIds: Array.isArray(cfg.excludeAccountIds) ? cfg.excludeAccountIds.map(String) : [],
        };
    }
    function listAccounts() {
        const data = (typeof getAccounts === 'function' && getAccounts()) || {};
        return Array.isArray(data.accounts) ? data.accounts : [];
    }
    function labelOf(channel) {
        return channel === 'qq' ? 'QQ（NapCat）' : '应用宝（微信）';
    }
    // 判定账号走哪条在线检测链路；返回 null 表示本服务不接管（例如手动填 Code 的号），
    // 不接管就不做任何事，避免对未知登录方式的账号瞎启动。
    function detectChannel(account) {
        const platform = String(account.platform || 'qq').toLowerCase();
        const loginType = String(account.loginType || '').toLowerCase();
        if (platform === 'qq')
            return loginType === 'napcat_open_auth' || !loginType ? 'qq' : null;
        if (platform === 'wx' && loginType === 'yyb')
            return 'yyb';
        return null;
    }
    async function checkQqOnline() {
        try {
            await checkNapCatBridge();
            return { online: true, detail: 'NapCat 桥接正常' };
        }
        catch (err) {
            return { online: false, detail: (err && err.message) || 'NapCat 桥接不可用' };
        }
    }
    async function checkYybOnline() {
        const wx = (typeof store.getGlobalWxConfig === 'function' && store.getGlobalWxConfig()) || {};
        if (wx.enabled === false)
            return { online: false, detail: '应用宝登录未启用' };
        const base = String(wx.apiBase || 'http://127.0.0.1:8450')
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/wxapp\/getCode$/i, '')
            .replace(/\/wxapp$/i, '');
        const token = String(wx.apiKey || '').trim();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(`${base}/health`, {
                method: 'GET',
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: controller.signal,
            });
            const data = await res.json().catch(() => null);
            const ok = !!data && Number(data.code) === 0 && (!data.data || data.data.ok !== false);
            return ok
                ? { online: true, detail: '应用宝服务正常' }
                : { online: false, detail: (data && data.msg) || `应用宝健康检查返回 HTTP ${res.status}` };
        }
        catch (err) {
            return { online: false, detail: (err && err.message) || '应用宝服务不可达' };
        }
        finally {
            clearTimeout(timer);
        }
    }
    function bumpFail(accountId, reason) {
        const fails = (failCount.get(accountId) || 0) + 1;
        failCount.set(accountId, fails);
        const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, fails - 1));
        nextAttemptAt.set(accountId, Date.now() + backoff);
        const account = listAccounts().find(acc => String(acc.id) === accountId);
        const name = (account && account.name) || accountId;
        addAccountLog('auto_start_online_failed', `自动启动挂机失败: ${reason}`, accountId, name, { reason });
        log('错误', `[自动挂机] 自动启动失败: ${name} - ${reason}（${Math.round(backoff / 60000)} 分钟后重试）`, {
            accountId,
            accountName: name,
        });
    }
    async function checkOnce() {
        const cfg = getConfig();
        if (!cfg.enabled || ticking)
            return;
        ticking = true;
        try {
            const accounts = listAccounts();
            for (const account of accounts) {
                if (!account || !account.id)
                    continue;
                const accountId = String(account.id);
                const channel = detectChannel(account);
                if (!channel)
                    continue;
                if (cfg.excludeAccountIds.includes(accountId))
                    continue;
                // 闸 1：已经在跑，直接跳过（核心防循环）
                if (typeof isAccountRunning === 'function' && isAccountRunning(account.id))
                    continue;
                const now = Date.now();
                // 闸 2：上一次启动还没返回
                if (pending.has(accountId))
                    continue;
                // 闸 3 + 4：冷却期 / 失败退避未过
                if (now < (nextAttemptAt.get(accountId) || 0))
                    continue;
                const probe = channel === 'qq' ? await checkQqOnline() : await checkYybOnline();
                if (!probe.online) {
                    const last = offlineLoggedAt.get(accountId) || 0;
                    if (now - last > OFFLINE_LOG_THROTTLE_MS) {
                        offlineLoggedAt.set(accountId, now);
                        log('系统', `[自动挂机] ${labelOf(channel)} 未在线，暂不启动: ${account.name || accountId}（${probe.detail}）`, {
                            accountId,
                            accountName: account.name || '',
                        });
                    }
                    continue;
                }
                const controls = (typeof resolveWorkerControls === 'function' && resolveWorkerControls()) || {};
                if (typeof controls.startWorker !== 'function')
                    continue;
                pending.add(accountId);
                offlineLoggedAt.delete(accountId);
                log('系统', `[自动挂机] 检测到 ${labelOf(channel)} 在线且挂机未运行，正在自动启动: ${account.name || accountId}`, {
                    accountId,
                    accountName: account.name || '',
                });
                try {
                    const ok = await controls.startWorker(account);
                    if (ok) {
                        failCount.delete(accountId);
                        nextAttemptAt.set(accountId, Date.now() + COOLDOWN_MS);
                        addAccountLog('auto_start_online', `检测到 ${labelOf(channel)} 在线，已自动启动挂机`, account.id, account.name || '');
                        log('系统', `[自动挂机] 已自动启动挂机: ${account.name || accountId}`, {
                            accountId,
                            accountName: account.name || '',
                        });
                    }
                    else {
                        // startWorker 返回 false = 已在运行或缺少 Code，按失败退避处理，不硬顶
                        bumpFail(accountId, '启动被拒绝（可能已在运行或 Code 无效）');
                    }
                }
                catch (err) {
                    bumpFail(accountId, (err && err.message) || String(err || 'unknown error'));
                }
                finally {
                    pending.delete(accountId);
                }
            }
        }
        finally {
            ticking = false;
        }
    }
    function start() {
        const cfg = getConfig();
        scheduler.clear(TASK);
        if (!cfg.enabled) {
            log('系统', '[自动挂机] 在线自动启动已关闭（FARM_AUTO_START_ONLINE=0）');
            return;
        }
        scheduler.setIntervalTask(TASK, cfg.intervalMinutes * 60 * 1000, checkOnce, { preventOverlap: true });
        log('系统', `[自动挂机] 在线自动启动已启用：每 ${cfg.intervalMinutes} 分钟检测一次，仅在 bot 未运行时拉起`);
    }
    function stop() {
        scheduler.clearAll();
        pending.clear();
    }
    return { start, stop, reload: start, checkOnce };
}
module.exports = { createAutoStartOnlineService };
//# sourceMappingURL=auto-start-online.js.map
