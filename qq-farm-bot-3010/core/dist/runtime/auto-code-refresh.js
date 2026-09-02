"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fetch = require('node-fetch');
const { authorizeNapCatFarm } = require('../services/napcat-bridge-client');
const { createScheduler } = require('../services/scheduler');
function createAutoCodeRefreshService(deps) {
    const { store, getAccounts, addOrUpdateAccount, resolveWorkerControls, log, addAccountLog, } = deps;
    const scheduler = createScheduler('auto_code_refresh');
    function getTaskName(accountId) {
        return `refresh_${String(accountId || '')}`;
    }
    function findAccount(accountId) {
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        return accounts.find(acc => String(acc.id) === String(accountId));
    }
    function normalizeConfig(accountId) {
        const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
        return {
            enabled: cfg && cfg.enabled === true,
            intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
        };
    }
    function getWxConfig() {
        return store.getGlobalWxConfig ? store.getGlobalWxConfig() : {};
    }
    // [patched 2026-08-17] 换码源改为本地 YYB Go /wxapp/getCode。
    // 原实现走第三方 https://code.z74d.top/api，该站已不可用（read ECONNRESET），
    // 导致自动刷新 Code 全部失败、微信账号一天内掉线。
    async function requestFarmCode(account, wxConfig) {
        const ref = String((account && (account.yybOpenid || account.wxid)) || '').trim();
        if (!ref)
            throw new Error('账号缺少 yybOpenid/wxid，无法自动刷新 Code');
        const apiKey = String(wxConfig.apiKey || '').trim();
        const appId = String(wxConfig.appId || 'wx5306c5978fdb76e4').trim();
        const rawBase = String(wxConfig.apiBase || 'http://127.0.0.1:8450').trim().replace(/\/+$/, '');
        const base = rawBase
            .replace(/\/wxapp\/getCode$/i, '')
            .replace(/\/wxapp$/i, '')
            .replace(/\/accounts$/i, '');
        if (!base)
            throw new Error('应用宝接口地址未配置');
        if (!apiKey)
            throw new Error('应用宝 API Token 未配置');
        const response = await fetch(`${base}/wxapp/getCode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ ref, app_id: appId }),
        });
        const data = await response.json();
        const code = data && data.data && data.data.result && data.data.result.code;
        if (data && data.code === 0 && code)
            return String(code);
        throw new Error((data && data.msg) || `应用宝获取 Code 失败 (HTTP ${response.status})`);
    }
    async function refreshAccountCode(accountId, reason = 'timer') {
        const account = findAccount(accountId);
        if (!account)
            return false;
        const platform = String(account.platform || 'qq').toLowerCase();
        if (platform === 'qq' && String(account.loginType || '') === 'napcat_open_auth') {
            try {
                // 同上：定时刷 Code 走 system:* 归属，撞上用户正在扫码时让路（409 走既有失败重试）。
                const result = await authorizeNapCatFarm(String(account.uin || account.qq || '').trim(), `system:auto-code:${String(account.uin || account.qq || '').trim()}`);
                const authorization = result.authorization || {};
                const profile = result.profile || {};
                if (!authorization.code)
                    throw new Error('QQ 授权未返回农场 Code');
                const boundOpenId = String(account.openID || account.openid || '').trim();
                if (boundOpenId && authorization.openID && authorization.openID !== boundOpenId) {
                    throw new Error('QQ 快速登录账号与农场账号不匹配');
                }
                const nextAccount = {
                    ...account,
                    code: authorization.code,
                    openID: authorization.openID || boundOpenId,
                    openid: authorization.openID || boundOpenId,
                    uin: profile.uin || account.uin || '',
                    qq: profile.uin || account.qq || '',
                    avatar: profile.avatar || account.avatar || '',
                };
                addOrUpdateAccount(nextAccount);
                const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
                if (typeof controls.restartWorker === 'function')
                    controls.restartWorker(nextAccount);
                addAccountLog('auto_code_refresh', `QQ Code 自动刷新成功，已重启账号: ${account.name || account.id}`, account.id, account.name, { reason });
                log('系统', `QQ Code 自动刷新成功: ${account.name || account.id}`, {
                    accountId: String(account.id),
                    accountName: account.name || '',
                });
                return true;
            }
            catch (err) {
                addAccountLog('auto_code_refresh_failed', `QQ Code 自动刷新失败: ${err.message}`, account.id, account.name, { reason });
                log('错误', `QQ Code 自动刷新失败: ${account.name || account.id} - ${err.message}`, {
                    accountId: String(account.id),
                    accountName: account.name || '',
                });
                return false;
            }
        }
        const wxConfig = getWxConfig();
        if (wxConfig.enabled === false) {
            log('系统', '自动刷新 Code 跳过: 微信登录未启用', {
                accountId: String(accountId),
                accountName: account.name,
            });
            return false;
        }
        try {
            const code = await requestFarmCode(account, wxConfig);
            const nextAccount = { ...account, code };
            addOrUpdateAccount(nextAccount);
            const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
            if (typeof controls.restartWorker === 'function')
                controls.restartWorker(nextAccount);
            addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${account.name}`, account.id, account.name, { reason });
            log('系统', `自动刷新 Code 成功: ${account.name}`, {
                accountId: String(account.id),
                accountName: account.name,
            });
            return true;
        }
        catch (err) {
            addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${err.message}`, account.id, account.name, { reason });
            log('错误', `自动刷新 Code 失败: ${account.name} - ${err.message}`, {
                accountId: String(account.id),
                accountName: account.name,
            });
            return false;
        }
    }
    function scheduleAccount(accountId) {
        // [改造 2026-09-02] 定时刷新 Code 已按需求移除，换码改为事件驱动：
        // 仅在账号掉线 / 被踢下线时，由 worker-manager 的 scheduleReconnect
        // 走 refreshNapcatCodeIfNeeded(QQ) / refreshYybCodeIfNeeded(微信) 换新码并重连，
        // 该流程自带去重队列与最大重试次数，不会无限刷新。
        const taskName = getTaskName(accountId);
        scheduler.clear(taskName);
        const account = findAccount(accountId);
        log('系统', `自动刷新 Code 已改为掉线触发（定时刷新已移除）: ${(account && account.name) || accountId}`, {
            accountId: String(accountId),
            accountName: (account && account.name) || '',
        });
    }
    function rescheduleAll() {
        scheduler.clearAll();
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        for (const account of accounts) {
            scheduleAccount(account.id);
        }
    }
    function stopAccount(accountId) {
        scheduler.clear(getTaskName(accountId));
    }
    return {
        refreshAccountCode,
        scheduleAccount,
        rescheduleAll,
        stopAccount,
    };
}
module.exports = { createAutoCodeRefreshService };
//# sourceMappingURL=auto-code-refresh.js.map