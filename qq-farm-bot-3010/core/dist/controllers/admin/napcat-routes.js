"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { authorizeNapCatFarm, checkNapCatBridge, getNapCatLoginStatus, getNapCatQrCode, getNapCatQrImage, reclaimNapCatScanLease, refreshNapCatQrCode, releaseNapCatScanLease, } = require('../../services/napcat-bridge-client');
const NAPCAT_FARM_APP_ID = '1112386029';
// ===== 农场 Code 授权：异步任务表 =====
// 授权实测 22~110 秒（无活会话时还要先拉起 QQ）。同步等待会撞穿
// Cloudflare 免费隧道约 100 秒的响应超时，边缘直接回 502 错误页（HTML），
// 前端取不到 error 字段，只显示一句「Request failed with status code 502」。
// 改成「提交任务 + 轮询结果」，每个 HTTP 请求都在毫秒级返回，彻底绕开超时。
const FARM_CODE_TASK_TTL_MS = 10 * 60 * 1000;
const farmCodeTasks = new Map();
function pruneFarmCodeTasks() {
    const now = Date.now();
    for (const [id, task] of farmCodeTasks) {
        if (now - task.createdAt > FARM_CODE_TASK_TTL_MS)
            farmCodeTasks.delete(id);
    }
}
function createFarmCodeTask(owner) {
    pruneFarmCodeTasks();
    const taskId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    farmCodeTasks.set(taskId, {
        status: 'running', result: null, error: '', busy: false, retryAfterMs: 0,
        owner: String(owner || ''), createdAt: Date.now(),
    });
    return taskId;
}
// NapCat 扫码是全局单例，桥接侧按 owner 做租约归属校验。
// 面板是 token 鉴权，没有用户体系，owner 退回 token 前缀。
// 没有归属标识就无法保护，宁可拒绝也不要发一张别人的二维码。
function scanOwner(req) {
    const token = String(req.adminToken || '').trim();
    return token ? `token:${token.slice(0, 12)}` : '';
}
// 租约冲突（409）不是故障，要原样把等待提示透给前端，别糊成 502。
function sendBridgeError(res, error) {
    if (error && error.busy) {
        res.status(409).json({
            ok: false,
            error: error.message,
            busy: true,
            retryAfterMs: error.retryAfterMs || 0,
        });
        return;
    }
    res.status(502).json({ ok: false, error: error.message });
}
function saveAccount(payload) {
    const store = require('../../models/store');
    if (store && typeof store.addOrUpdateAccount === 'function') {
        return store.addOrUpdateAccount(payload);
    }
    throw new Error('账号存储服务不可用');
}
function mountNapCatRoutes(app, ctx) {
    app.get('/api/qr/napcat-login', async (req, res) => {
        try {
            const data = await getNapCatQrCode(scanOwner(req));
            res.json({ ok: true, data });
        }
        catch (error) {
            sendBridgeError(res, error);
        }
    });
    app.post('/api/qr/napcat-refresh', async (req, res) => {
        try {
            const data = await refreshNapCatQrCode(scanOwner(req));
            res.json({ ok: true, data });
        }
        catch (error) {
            sendBridgeError(res, error);
        }
    });
    // 前端 2s 轮询"扫没扫"走这个无副作用接口，不能用 /napcat-login：
    // 后者会在二维码过期时重启 QQ，把用户正在扫的会话反复打死。
    // 传 owner 还负责给持有者续租，并避免非持有者看到别人的登录态。
    app.get('/api/qr/napcat-poll', async (req, res) => {
        try {
            const data = await getNapCatLoginStatus(scanOwner(req));
            res.json({ ok: true, data });
        }
        catch (error) {
            sendBridgeError(res, error);
        }
    });
    // 无副作用：只读当前 qrcode.png。NapCat 自己每 ~122s 重写该文件轮换二维码，
    // 前端靠 /napcat-poll 的 updatedAt 变化拉这个接口跟随换图，全程不碰进程。
    app.get('/api/qr/napcat-image', async (req, res) => {
        try {
            const data = await getNapCatQrImage(scanOwner(req));
            res.json({ ok: true, data });
        }
        catch (error) {
            sendBridgeError(res, error);
        }
    });
    app.get('/api/qr/napcat-status', async (_req, res) => {
        try {
            await checkNapCatBridge();
            res.json({ ok: true, data: { bridge: 'reachable', appId: NAPCAT_FARM_APP_ID } });
        }
        catch (error) {
            res.status(503).json({ ok: false, error: error.message });
        }
    });
    // 关弹窗/关页面时主动交回扫码租约，不用等空闲超时，下一个人立刻能扫。
    // 走 fetch keepalive 时前端不看响应，所以这里永远回 200，失败也只是退化成等超时。
    app.post('/api/qr/napcat-release', async (req, res) => {
        try {
            const data = await releaseNapCatScanLease(scanOwner(req));
            res.json({ ok: true, data });
        }
        catch (error) {
            res.json({ ok: true, data: { released: false, reason: error.message } });
        }
    });
    // 页面从后台恢复时软重新占用（不换码、不重启会话）。
    // 被别人抢走时要如实回 409，前端据此切成排队提示，而不是让用户对着一张已失效的码干扫。
    app.post('/api/qr/napcat-reclaim', async (req, res) => {
        try {
            const data = await reclaimNapCatScanLease(scanOwner(req));
            res.json({ ok: true, data });
        }
        catch (error) {
            sendBridgeError(res, error);
        }
    });
    app.post('/api/qr/napcat-farm-code', async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const accountId = String(body.accountId || body.id || '').trim();
            const allAccounts = ctx.provider.getAccounts ? (ctx.provider.getAccounts().accounts || []) : [];
            const existing = accountId
                ? allAccounts.find((account) => String(account.id) === accountId)
                : null;
            if (accountId && !existing)
                return res.status(404).json({ ok: false, error: '账号不存在' });
            if (existing && String(existing.platform || 'qq').toLowerCase() !== 'qq') {
                return res.status(400).json({ ok: false, error: 'QQ 授权不能覆盖微信账号' });
            }
            const owner = scanOwner(req);
            const taskId = createFarmCodeTask(owner);
            // 授权放到后台跑，HTTP 立即返回任务号，前端轮询结果。
            void performFarmCodeAuth(ctx, { body, owner, accountId, existing })
                .then((result) => {
                farmCodeTasks.set(taskId, {
                    status: 'done', result, error: '', busy: false, retryAfterMs: 0,
                    owner, createdAt: Date.now(),
                });
            })
                .catch((error) => {
                farmCodeTasks.set(taskId, {
                    status: 'error', result: null, busy: !!error.busy,
                    retryAfterMs: Number(error.retryAfterMs) || 0,
                    error: error && error.message ? error.message : String(error),
                    owner, createdAt: Date.now(),
                });
            });
            return res.json({ ok: true, pending: true, taskId });
        }
        catch (error) {
            sendBridgeError(res, error);
        }
    });
    // 轮询异步授权任务的结果。taskId 随机不可猜，并校验 owner 只让发起者查询。
    app.get('/api/qr/napcat-farm-code/status', (req, res) => {
        const taskId = String(req.query.taskId || '').trim();
        const task = taskId ? farmCodeTasks.get(taskId) : null;
        if (!task)
            return res.status(404).json({ ok: false, error: '授权任务不存在或已过期' });
        if (task.owner && task.owner !== scanOwner(req)) {
            return res.status(403).json({ ok: false, error: '无权查询该授权任务' });
        }
        return res.json({
            ok: true,
            status: task.status,
            result: task.result,
            error: task.error,
            busy: !!task.busy,
            retryAfterMs: task.retryAfterMs || 0,
        });
    });
    // 真正的授权 + 落库逻辑：不碰 req/res，纯返回，便于在后台任务里执行。
    async function performFarmCodeAuth(ctx, { body, owner, accountId, existing }) {
        const data = await authorizeNapCatFarm(existing && (existing.uin || existing.qq) || '', owner);
        const authorization = data.authorization || {};
        const profile = data.profile || {};
        if (!authorization.code)
            throw new Error('QQ 授权未返回农场 Code');
        const boundOpenId = String(existing && (existing.openID || existing.openid) || '').trim();
        if (existing && boundOpenId && authorization.openID && authorization.openID !== boundOpenId) {
            throw new Error('当前 QQ 与目标农场账号不匹配');
        }
        const provider = ctx.provider;
        const payload = {
            ...(existing || {}),
            ...(existing ? { id: accountId } : {}),
            name: existing
                ? String(body.name ?? existing.name ?? '').trim()
                : String(body.name || '').trim(),
            code: authorization.code,
            openID: authorization.openID || boundOpenId,
            openid: authorization.openID || boundOpenId,
            uin: profile.uin || existing?.uin || '',
            qq: profile.uin || existing?.qq || '',
            avatar: profile.avatar || existing?.avatar || '',
            platform: 'qq',
            loginType: 'napcat_open_auth',
        };
        const wasRunning = provider.isAccountRunning ? provider.isAccountRunning(accountId) : false;
        const saved = saveAccount(payload);
        const updated = existing
            ? saved.accounts.find((account) => String(account.id) === accountId)
            : saved.accounts.at(-1);
        if (!updated)
            throw new Error('保存 QQ 农场账号失败');
        // 扫码新建/更新的账号必须当场把定时刷新挂上。
        // scheduleAutoCodeRefresh 原本只在「保存设置」和 core 启动时调用，于是扫出来的账号
        // 在设置页显示着「已开启」，定时器其实没注册 —— 失效触发那层还能用，
        // 但定时兜底是空的，得等下次 core 重启才补上。默认值改成 enabled:true 之后更明显：
        // 用户一行配置都没动，界面看着是开的，实际没在跑。
        if (typeof provider.scheduleAutoCodeRefresh === 'function') {
            try {
                provider.scheduleAutoCodeRefresh(updated.id);
            }
            catch (err) {
                // 注册失败不该影响扫码结果本身；core 重启时 rescheduleAll() 会补上
                provider.addAccountLog('auto_refresh_schedule_failed', `自动刷新 Code 定时器注册失败: ${err && err.message ? err.message : String(err)}`, updated.id, updated.name || '');
            }
        }
        // 扫码链路刚把全新 Code 写进 store，用 skipLoginRefresh 避免 startWorker
        // 再向 NapCat 授权一次（重复授权既慢又可能撞上限流）。
        let startAction = 'none';
        if (wasRunning && provider.restartAccount) {
            provider.restartAccount(updated.id, { skipLoginRefresh: true });
            startAction = 'restart';
        }
        else if (provider.startAccount) {
            // 关键：已存在但当前停止的账号也要拉起。
            // Code 过期把账号停掉恰恰是用户来扫码的最常见原因，
            // 原逻辑只在 wasRunning 时重启，导致扫完码账号仍是停止状态。
            provider.startAccount(updated.id, { skipLoginRefresh: true });
            startAction = 'start';
        }
        if (provider.addAccountLog) {
            const startNote = startAction === 'restart'
                ? '，已重启账号'
                : (startAction === 'start' ? '，已自动启动账号' : '');
            provider.addAccountLog(existing ? 'update' : 'add', `通过 QQ 扫码${existing ? '更新' : '添加'}农场授权${startNote}`, updated.id, updated.name || '');
        }
        return {
            success: true,
            account: { id: updated.id, name: updated.name, platform: 'qq', loginType: 'napcat_open_auth' },
            authorization: { appId: NAPCAT_FARM_APP_ID, source: 'NapCat OpenAuth', expiresAt: authorization.expiresAt || null },
        };
    }
}
module.exports = { mountNapCatRoutes };
//# sourceMappingURL=napcat-routes.js.map