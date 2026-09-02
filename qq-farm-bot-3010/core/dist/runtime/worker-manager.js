"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { createScheduler } = require('../services/scheduler');
const DEFAULT_API_CALL_TIMEOUT_MS = 10000;
// 好友现场天气需要逐个 Enter/Leave，单批最多 5 位好友；
// 好友列表只读缓存或拉一次名单，给的余量少一些。
const API_CALL_TIMEOUTS_MS = {
    scanWeatherFriends: 60000,
    getWeatherFriends: 30000,
};
function createWorkerManager(options) {
    const { fork, WorkerThread, runtimeMode = 'thread', processRef, mainEntryPath, workerScriptPath, workers, globalLogs, log, addAccountLog, normalizeStatusForPanel, buildConfigSnapshotForAccount, getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush, addOrUpdateAccount, deleteAccount, onStatusSync, onWorkerLog, } = options;
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';
    // 离线自动重连计数（独立于 startWorker，保证 maxAttempts 生效）
    const reconnectAttemptsMap = new Map();
    const reconnectScheduled = new Set();
    const RECONNECT_SUCCESS_STABLE_MS = 10 * 60 * 1000;
    function createThreadWorker(account) {
        const workerOptions = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        };
        // When running from source with tsx, configure worker to use tsx
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }
    function createForkWorker(account) {
        if (processRef.pkg) {
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        const forkOptions = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        };
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }
    function createWorkerProcess(account) {
        if (useThreadRuntime)
            return createThreadWorker(account);
        return createForkWorker(account);
    }
    /**
     * QQ 账号启动/重连前先通过 NapCat OpenAuth 换新 Code，避免拿旧 Code 直接连接失败。
     * 失败会 throw，由调用方决定是返回 false（启动失败）还是走失败重试。
     */
    async function refreshNapcatCodeIfNeeded(account) {
        const isQqAccount = account
            && String(account.platform || 'qq').toLowerCase() === 'qq';
        if (!isQqAccount)
            return;
        const uin = String(account.uin || account.qq || '').trim();
        if (!uin)
            throw new Error('NapCat QQ 账号缺少 UIN，无法刷新 Code');
        const { authorizeNapCatFarm } = require('../services/napcat-bridge-client');
        // 后台启动/重连属于无人值守任务，也必须带稳定的 system:* 租约归属。
        // 扫码租约加固后 owner 为空会被桥接明确拒绝（"缺少扫码会话归属标识"）。
        const result = await authorizeNapCatFarm(uin, `system:start:${uin}`);
        const authorization = result.authorization || {};
        const profile = result.profile || {};
        if (!authorization.code)
            throw new Error('NapCat QQ 授权未返回农场 Code');
        const boundOpenId = String(account.openID || account.openid || account.openId || '').trim();
        if (boundOpenId && authorization.openID && authorization.openID !== boundOpenId) {
            throw new Error('NapCat QQ 与目标农场账号不匹配');
        }
        Object.assign(account, {
            code: authorization.code,
            platform: 'qq',
            loginType: 'napcat_open_auth',
            openID: authorization.openID || boundOpenId,
            openid: authorization.openID || boundOpenId,
            openId: authorization.openID || boundOpenId,
            uin: profile.uin || uin,
            qq: profile.uin || uin,
            avatar: profile.avatar || account.avatar || '',
        });
        addOrUpdateAccount(account);
        log('系统', `账号 ${account.name || account.id} 已通过 NapCat 刷新 QQ Code`, {
            accountId: String(account.id),
            accountName: account.name || '',
        });
    }
    /**
     * [patched] 微信(应用宝/YYB)账号启动/重连前先向本地 yyb-go 换新 Code。
     * 微信农场 Code 是一次性且短时效的，拿旧 Code 重连必然 ws_error:400，
     * 因此必须与 QQ 的 refreshNapcatCodeIfNeeded 对齐：连接前一定拿新码。
     */
    async function refreshYybCodeIfNeeded(account) {
        const isYybWx = account
            && String(account.platform || '').toLowerCase() === 'wx'
            && String(account.loginType || '') === 'yyb';
        if (!isYybWx)
            return;
        const ref = String(account.yybOpenid || account.wxid || '').trim();
        if (!ref)
            throw new Error('微信账号缺少 yybOpenid/wxid，无法刷新 Code');
        const storeRef = require('../models/store');
        const wxConfig = (storeRef.getGlobalWxConfig ? storeRef.getGlobalWxConfig() : {}) || {};
        if (wxConfig.enabled === false)
            throw new Error('微信登录未启用');
        const apiKey = String(wxConfig.apiKey || processRef.env.YYB_API_KEY || '').trim();
        if (!apiKey)
            throw new Error('应用宝 API Token 未配置');
        const appId = String(wxConfig.appId || 'wx5306c5978fdb76e4').trim();
        const base = String(wxConfig.apiBase || processRef.env.YYB_API_URL || 'http://127.0.0.1:8450')
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/wxapp\/getCode$/i, '')
            .replace(/\/wxapp$/i, '')
            .replace(/\/accounts$/i, '');
        if (!base)
            throw new Error('应用宝接口地址未配置');
        const fetchFn = require('node-fetch');
        const response = await fetchFn(`${base}/wxapp/getCode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ ref, app_id: appId }),
        });
        const data = await response.json();
        const code = data && data.data && data.data.result && data.data.result.code;
        if (!(data && data.code === 0 && code))
            throw new Error((data && data.msg) || `应用宝获取 Code 失败 (HTTP ${response.status})`);
        Object.assign(account, { code: String(code) });
        addOrUpdateAccount(account);
        log('系统', `账号 ${account.name || account.id} 已通过应用宝刷新微信 Code`, {
            accountId: String(account.id),
            accountName: account.name || '',
        });
    }
    // [patched 2026-09-02] startWorker 幂等占位。
    // startWorker 里 workers[account.id] 是在 await 刷新 Code 之后才写入的，
    // 中间有数十秒的并发窗口：离线重连 与 在线自动挂机巡检 可能同时进来，
    // 给同一账号 fork 出两个 worker（孤儿进程 + 反复点火）。
    // 进函数即同步登记，出函数必释放，保证同一账号同时只有一个 startWorker 在跑。
    const startingIds = new Set();
    async function startWorker(account, options = {}) {
        if (!account || !account.id)
            return false;
        if (workers[account.id] || startingIds.has(account.id))
            return false;
        startingIds.add(account.id);
        try {
            return await startWorkerInner(account, options);
        }
        finally {
            startingIds.delete(account.id);
        }
    }
    async function startWorkerInner(account, options = {}) {
        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });
        // 用户主动启动 QQ 时先通过 NapCat 获取新 Code，避免先拿旧 Code 连接失败
        // 再进入离线重连。自动重连分支已经刷新过，使用 skipLoginRefresh 防止重复授权。
        const platform = String(account.platform || 'qq').toLowerCase();
        if (platform === 'qq' && options.skipLoginRefresh !== true) {
            try {
                await refreshNapcatCodeIfNeeded(account);
            }
            catch (err) {
                const reason = err && err.message ? err.message : String(err || 'unknown error');
                log('错误', `账号 ${account.name || account.id} NapCat 启动前刷新失败: ${reason}`, {
                    accountId: String(account.id),
                    accountName: account.name || '',
                });
                addAccountLog('napcat_start_refresh_failed', `NapCat QQ 启动前刷新失败: ${reason}`, account.id, account.name || '', { reason });
                return false;
            }
        }
        // [patched] 微信 YYB 账号同样在启动前换新 Code（旧码必然 400 被拒）。
        if (platform === 'wx'
            && String(account.loginType || '') === 'yyb'
            && options.skipLoginRefresh !== true) {
            try {
                await refreshYybCodeIfNeeded(account);
            }
            catch (err) {
                const reason = err && err.message ? err.message : String(err || 'unknown error');
                log('错误', `账号 ${account.name || account.id} 微信启动前刷新 Code 失败: ${reason}`, {
                    accountId: String(account.id),
                    accountName: account.name || '',
                });
                addAccountLog('yyb_start_refresh_failed', `微信启动前刷新 Code 失败: ${reason}`, account.id, account.name || '', { reason });
                return false;
            }
        }
        let child = null;
        try {
            child = createWorkerProcess(account);
        }
        catch (err) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }
        workers[account.id] = {
            process: child,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            nick: account.nick || '',
            platform: account.platform || 'qq',
            loginType: account.loginType || '',
            gid: account.gid || '',
            openId: account.openId || account.open_id || '',
            qq: account.qq || account.uin || '',
            uin: account.uin || account.qq || '',
            avatar: account.avatar || account.avatarUrl || '',
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            terminalHandled: false,
            wsError: null,
        };
        const initialConfigSnapshot = buildConfigSnapshotForAccount(account.id);
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
                systemTimeZone: initialConfigSnapshot.systemTimeZone,
                systemServerUrl: initialConfigSnapshot.systemServerUrl,
                systemClientVersion: initialConfigSnapshot.systemClientVersion,
            },
        });
        child.send({ type: 'config_sync', config: initialConfigSnapshot });
        child.on('message', (msg) => {
            handleWorkerMessage(account.id, child, msg);
        });
        child.on('error', (err) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });
        child.on('exit', (code, signal) => {
            const current = workers[account.id];
            if (!current || current.process !== child)
                return;
            const displayName = current.name || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });
            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);
            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    }
                    catch { }
                }
                current.requests.clear();
            }
            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }
    function stopWorker(accountId, opts = {}) {
        const { resetReconnect = true } = opts;
        const worker = workers[accountId];
        if (!worker)
            return;
        // 取消尚未触发的离线重连计划
        managerScheduler.clear(`reconnect_attempt_${accountId}`);
        managerScheduler.clear(`reconnect_reset_${accountId}`);
        if (resetReconnect) {
            // 仅「账号退役 / 用户主动停止」场景清零计数；自动重连循环内不在此清零
            reconnectAttemptsMap.delete(accountId);
            reconnectScheduled.delete(accountId);
        }
        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }
    function restartWorker(account, options = {}) {
        if (!account)
            return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) {
            startWorker(account, options);
            return;
        }
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started)
                return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) {
                startWorker(account, options);
                return;
            }
            if (current.process !== proc)
                return;
            delete workers[accountId];
            startWorker(account, options);
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc)
                return false;
            try {
                current.process.kill();
            }
            catch { }
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started)
                return;
            killIfStale();
            startOnce();
        });
    }
    /**
     * 解析某账号的离线重连配置。
     * 第三方账号（provider==='thirdparty'）优先使用账号级独立配置（thirdparty.*），
     * 未设置账号级配置时回退到全局 wxConfig（与内置 YYB 一致）。
     */
    function resolveReconnectConfig(account) {
        const store = require('../models/store');
        const wxConfig = store.getGlobalWxConfig ? store.getGlobalWxConfig() : null;
        const globalCfg = {
            autoReconnect: !!(wxConfig && wxConfig.autoReconnect),
            reconnectDelayMin: wxConfig ? wxConfig.reconnectDelayMin : 5,
            reconnectMaxAttempts: wxConfig ? wxConfig.reconnectMaxAttempts : 3,
        };
        if (account && account.provider === 'thirdparty' && account.thirdparty) {
            const tp = account.thirdparty;
            const hasAccountLevel = tp.autoReconnect !== undefined
                || tp.reconnectDelayMin !== undefined
                || tp.reconnectMaxAttempts !== undefined;
            if (hasAccountLevel) {
                return {
                    autoReconnect: tp.autoReconnect === undefined
                        ? globalCfg.autoReconnect
                        : tp.autoReconnect === true,
                    reconnectDelayMin: (tp.reconnectDelayMin === undefined || tp.reconnectDelayMin === null || tp.reconnectDelayMin === '')
                        ? globalCfg.reconnectDelayMin
                        : Math.max(1, Number(tp.reconnectDelayMin) || globalCfg.reconnectDelayMin),
                    reconnectMaxAttempts: (tp.reconnectMaxAttempts === undefined || tp.reconnectMaxAttempts === null || tp.reconnectMaxAttempts === '')
                        ? globalCfg.reconnectMaxAttempts
                        : Math.max(1, Number(tp.reconnectMaxAttempts) || globalCfg.reconnectMaxAttempts),
                    source: 'account',
                };
            }
        }
        return { ...globalCfg, source: 'global' };
    }
    /**
     * 统一的离线重连调度。
     * NapCat QQ 账号重新启动时只向 NapCat 获取 Code；只有 loginType=yyb 的微信账号才走应用宝。
     */
    async function scheduleReconnect(accountId, reason) {
        const wrk = workers[accountId];
        const name = wrk ? wrk.name : accountId;
        if (reconnectScheduled.has(accountId)) {
            log('系统', `账号 ${name || accountId} 已在自动重连队列，忽略重复事件`, {
                accountId: String(accountId),
                accountName: name || '',
                reason,
            });
            return;
        }
        reconnectScheduled.add(accountId);
        log('系统', `账号 ${name} 触发离线重连调度 (${reason})`, {
            accountId: String(accountId),
            accountName: name,
            reason,
        });
        // 先停止当前 worker（清理进程）；自动重连流程内【不】清零计数，
        // 否则每次断线都被清零，maxAttempts 永不触发、无限重连。
        stopWorker(accountId, { resetReconnect: false });
        try {
            const store = require('../models/store');
            // 取完整账号（含第三方真实 token 与账号级离线重连配置）
            const accountsData = store.getAccounts();
            const account = (accountsData.accounts || []).find((a) => a.id === accountId);
            if (!account) {
                reconnectScheduled.delete(accountId);
                log('系统', `账号 ${name} 已不存在，取消自动重连`);
                return;
            }
            const isQqAccount = String(account.platform || 'qq').toLowerCase() === 'qq';
            if (isQqAccount) {
                const currentAttempt = reconnectAttemptsMap.get(accountId) || 0;
                const maxAttempts = 3;
                if (currentAttempt >= maxAttempts) {
                    log('系统', `账号 ${name || accountId} NapCat 自动重连已达上限(${maxAttempts}次)，停止重连`);
                    reconnectAttemptsMap.delete(accountId);
                    reconnectScheduled.delete(accountId);
                    return;
                }
                const nextAttempt = currentAttempt + 1;
                reconnectAttemptsMap.set(accountId, nextAttempt);
                log('系统', `QQ 账号 ${name || accountId} 将通过 NapCat 刷新 Code 并重连 (${nextAttempt}/${maxAttempts})`, {
                    accountId: String(accountId),
                    accountName: name || '',
                    reason,
                });
                managerScheduler.setTimeoutTask(`reconnect_attempt_${accountId}`, 1000, async () => {
                    reconnectScheduled.delete(accountId);
                    const latest = (store.getAccounts().accounts || []).find((a) => a.id === accountId);
                    if (!latest || workers[accountId])
                        return;
                    try {
                        await refreshNapcatCodeIfNeeded(latest);
                        const started = await startWorker(latest, { skipLoginRefresh: true });
                        if (started) {
                            addAccountLog('reconnect_success', `QQ 账号 ${name || accountId} 已通过 NapCat 恢复在线 (${nextAttempt}/${maxAttempts})`, accountId, name || '', { attempt: nextAttempt, maxAttempts, loginProvider: 'napcat' });
                        }
                    }
                    catch (error) {
                        const reasonMsg = error && error.message ? error.message : String(error || 'unknown error');
                        log('错误', `QQ 账号 ${name || accountId} NapCat 重连失败: ${reasonMsg}`, {
                            accountId: String(accountId),
                            accountName: name || '',
                        });
                        addAccountLog('napcat_reconnect_failed', `NapCat QQ 重连失败: ${reasonMsg}`, accountId, name || '', { reason: reasonMsg, attempt: nextAttempt });
                    }
                });
                return;
            }
            if (String(account.loginType || '') !== 'yyb' || String(account.platform || '').toLowerCase() !== 'wx') {
                reconnectScheduled.delete(accountId);
                log('系统', `账号 ${name || accountId} 不支持自动刷新 Code，已停止`);
                return;
            }
            const cfg = resolveReconnectConfig(account);
            if (!cfg.autoReconnect || !(cfg.reconnectDelayMin > 0)) {
                reconnectScheduled.delete(accountId);
                log('系统', `账号 ${name} 未启用应用宝离线重连，已停止`);
                return;
            }
            const attemptKey = `reconnect_attempt_${accountId}`;
            // 从独立计数 Map 读取（不受 startWorker 清零影响，保证 maxAttempts 生效）
            const currentAttempt = reconnectAttemptsMap.get(accountId) || 0;
            const maxAttempts = cfg.reconnectMaxAttempts;
            if (currentAttempt >= maxAttempts) {
                log('系统', `账号 ${name} 自动重连已达上限(${maxAttempts}次)，停止重连`, {
                    accountId: String(accountId),
                    attempts: currentAttempt,
                });
                reconnectAttemptsMap.delete(accountId);
                reconnectScheduled.delete(accountId);
                return;
            }
            // 记录重连计数（先自增，作为下一次判断基准）
            const nextAttempt = currentAttempt + 1;
            reconnectAttemptsMap.set(accountId, nextAttempt);
            // [patched] 掉线秒级恢复：首次重连 2 秒后带新 Code 重启（startWorker 会自动换码），
            // 后续尝试退避到配置的分钟级间隔，避免换码接口被风控。
            const fastFirstMs = 2000;
            const delayMs = nextAttempt === 1 ? fastFirstMs : cfg.reconnectDelayMin * 60 * 1000;
            const delayDesc = nextAttempt === 1 ? '2 秒' : `${cfg.reconnectDelayMin} 分钟`;
            log('系统', `账号 ${name} 将在 ${delayDesc}后自动重连 (${nextAttempt}/${maxAttempts})${cfg.source === 'account' ? ' [账号级配置]' : ' [全局配置]'}`, {
                accountId: String(accountId),
                delayMs,
                attempt: nextAttempt,
                maxAttempts,
            });
            managerScheduler.setTimeoutTask(attemptKey, delayMs, async () => {
                reconnectScheduled.delete(accountId);
                // 重连前检查账号是否还存在、是否已有 worker 在跑（无需重复重连）
                const currentWrk = workers[accountId];
                if (currentWrk)
                    return;
                try {
                    const accountsData2 = store.getAccounts();
                    const account2 = (accountsData2.accounts || []).find((a) => a.id === accountId);
                    if (!account2) {
                        log('系统', `账号 ${name} 已被删除，取消自动重连`);
                        reconnectAttemptsMap.delete(accountId);
                        return;
                    }
                    log('系统', `账号 ${name} 开始自动重连 (${nextAttempt}/${cfg.reconnectMaxAttempts})`);
                    const started = await startWorker(account2);
                    if (started) {
                        managerScheduler.setTimeoutTask(`reconnect_reset_${accountId}`, RECONNECT_SUCCESS_STABLE_MS, () => {
                            if (workers[accountId])
                                reconnectAttemptsMap.delete(accountId);
                        });
                        addAccountLog('reconnect_success', `账号 ${name} 已通过应用宝离线重连恢复在线 (${nextAttempt}/${cfg.reconnectMaxAttempts})`, accountId, name, { attempt: nextAttempt, maxAttempts: cfg.reconnectMaxAttempts });
                    }
                }
                catch (e) {
                    log('系统', `账号 ${name} 自动重连启动失败: ${e && e.message ? e.message : e}`);
                }
            });
        }
        catch (e) {
            reconnectScheduled.delete(accountId);
            log('系统', `账号 ${name} 自动重连逻辑异常: ${e && e.message ? e.message : e}`);
        }
    }
    function errorFromWorkerPayload(payload) {
        if (!payload || typeof payload !== 'object')
            return new Error(String(payload || 'Worker API error'));
        const error = new Error(String(payload.message || 'Worker API error'));
        if (payload.name)
            error.name = String(payload.name);
        if (payload.code !== undefined && payload.code !== null && payload.code !== '')
            error.code = payload.code;
        return error;
    }
    function handleWorkerMessage(accountId, sourceProcess, msg) {
        const worker = workers[accountId];
        if (!worker || worker.process !== sourceProcess)
            return;
        if (msg.type === 'status_sync') {
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }
            const profile = msg.data && msg.data.status && typeof msg.data.status === 'object'
                ? msg.data.status
                : {};
            const accountUpdate = { id: accountId };
            let profileChanged = false;
            if (profile.name) {
                const newNick = String(profile.name).trim();
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        accountUpdate.nick = newNick;
                        profileChanged = true;
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }
            const newAvatar = String(profile.avatarUrl || profile.avatar_url || '').trim();
            if (newAvatar && worker.avatar !== newAvatar) {
                worker.avatar = newAvatar;
                accountUpdate.avatar = newAvatar;
                profileChanged = true;
            }
            if (profileChanged) {
                addOrUpdateAccount(accountUpdate);
            }
            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
            }
            else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince)
                    worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs();
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog('offline_delete', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`, accountId, worker.name, { reason: 'offline_timeout', offlineMs });
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    }
                    catch (e) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        }
        else if (msg.type === 'log') {
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000)
                worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000)
                globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        }
        else if (msg.type === 'error') {
            const workerError = errorFromWorkerPayload(msg.error);
            log('错误', `账号[${accountId}]进程报错: ${workerError.message}`, {
                accountId: String(accountId),
                accountName: worker.name,
                errorCode: workerError.code,
                errorName: workerError.name,
            });
        }
        else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog('ws_400', `账号 ${worker.name} 登录失效，请更新 Code`, accountId, worker.name);
                triggerOfflineReminder({
                    accountId,
                    accountName: worker.name,
                    reason: `ws_error:${code}`,
                    offlineMs: 0,
                });
                // QQ 账号走 NapCat 自动补 Code 重连；微信账号走应用宝离线重连（受 autoReconnect 开关控制）
                scheduleReconnect(accountId, `ws_error:${code}`);
            }
        }
        else if (msg.type === 'account_kicked') {
            if (worker.terminalHandled)
                return;
            worker.terminalHandled = true;
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            // QQ 账号自动通过 NapCat 补 Code 重连，微信账号走应用宝离线重连（受 autoReconnect 开关控制）
            scheduleReconnect(accountId, `kickout:${reason}`);
        }
        else if (msg.type === 'account_disconnected') {
            if (worker.terminalHandled)
                return;
            worker.terminalHandled = true;
            const source = String(msg.source || 'ws_close');
            const code = Number(msg.code) || 0;
            const reason = String(msg.reason || '连接已断开');
            const phase = String(msg.phase || 'unknown');
            if (worker.status?.connection)
                worker.status.connection.connected = false;
            if (worker.requests.size > 0) {
                for (const [reqId, req] of worker.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${accountId}_${reqId}`);
                    try {
                        req.reject(new Error('账号连接已断开'));
                    }
                    catch { }
                }
                worker.requests.clear();
            }
            log('系统', `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`, {
                accountId: String(accountId),
                accountName: worker.name,
                source,
                code,
                phase,
            });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `disconnect:${source}:${phase}:${code}`,
                offlineMs: 0,
            });
            addAccountLog('disconnect_stop', `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`, accountId, worker.name, { source, code, reason, phase, connectionId: Number(msg.connectionId) || 0 });
            // QQ 账号走 NapCat 自动补 Code 重连；微信账号走应用宝离线重连（受 autoReconnect 开关控制）
            scheduleReconnect(accountId, `disconnect:${source}:${phase}:${code}`);
        }
        else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error)
                    req.reject(errorFromWorkerPayload(error));
                else
                    req.resolve(result);
                worker.requests.delete(id);
            }
        }
        else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        }
        else if (msg.type === 'known_friend_gids_sync') {
            const { setKnownFriendGids, getKnownFriendGidsManualLock } = require('../models/store');
            const gids = Array.isArray(msg.gids)
                ? msg.gids.map(Number).filter((gid) => Number.isFinite(gid) && gid > 0)
                : [];
            // 若用户已手动锁定 knownFriendGids，则忽略 worker 的自动合并同步，避免把过滤掉的 Lv1 重新加回
            if (getKnownFriendGidsManualLock && getKnownFriendGidsManualLock(accountId)) {
                log('好友', `已知好友 GID 已手动锁定，忽略 worker 自动合并同步(${gids.length} 个)`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                });
                return;
            }
            const saved = setKnownFriendGids(accountId, gids);
            worker.process.send({
                type: 'config_sync',
                config: buildConfigSnapshotForAccount(accountId),
            });
            log('好友', `已同步并持久化 ${saved.length} 个好友 GID`, {
                accountId: String(accountId),
                accountName: worker.name,
                friendCount: saved.length,
            });
        }
        else if (msg.type === 'push_notify') {
            const title = String(msg.title || '').trim();
            const content = String(msg.content || '').trim();
            if (!title || !content || typeof sendConfiguredPush !== 'function')
                return;
            Promise.resolve(sendConfiguredPush({
                title,
                content,
                accountId,
                accountName: worker.name,
            })).catch((e) => {
                log('错误', `事件提醒发送异常: ${e && e.message ? e.message : e}`);
            });
        }
        else if (msg.type === 'known_friend_gid_remove') {
            const { getKnownFriendGids, setKnownFriendGids } = require('../models/store');
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const current = getKnownFriendGids(accountId);
                setKnownFriendGids(accountId, current.filter((item) => Number(item) !== gid));
                worker.process.send({
                    type: 'config_sync',
                    config: buildConfigSnapshotForAccount(accountId),
                });
            }
        }
    }
    function callWorkerApi(accountId, method, ...args) {
        const worker = workers[accountId];
        if (!worker)
            return Promise.reject(new Error('账号未运行'));
        if (worker.stopping || worker.terminalHandled)
            return Promise.reject(new Error('账号已离线'));
        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });
            const timeoutMs = API_CALL_TIMEOUTS_MS[method] || DEFAULT_API_CALL_TIMEOUT_MS;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });
            worker.process.send({ type: 'api_call', id, method, args });
        });
    }
    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}
module.exports = {
    createWorkerManager,
};
//# sourceMappingURL=worker-manager.js.map