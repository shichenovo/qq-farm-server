"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http = require('node:http');
const SOCKET_PATH = process.env.NAPCAT_BRIDGE_SOCKET || '/run/qqfarm-napcat-bridge.sock';
function requestBridge(method, path, body = null, timeoutMs = 70000) {
    return new Promise((resolve, reject) => {
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            socketPath: SOCKET_PATH,
            path,
            method,
            timeout: timeoutMs,
            headers: payload ? {
                'content-type': 'application/json',
                'content-length': payload.length,
            } : {},
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                let data = null;
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                }
                catch {
                    return reject(new Error(`QQ 登录桥接返回非 JSON（HTTP ${res.statusCode}）`));
                }
                if (res.statusCode < 200 || res.statusCode >= 300 || !data.ok) {
                    const error = new Error(data.error || `QQ 登录桥接失败（HTTP ${res.statusCode}）`);
                    // 409 = 扫码单例被别人占用。标出来让上层能回明确的“稍后再试”，
                    // 而不是笼统报 502 让用户以为是自己网络坏了。
                    if (res.statusCode === 409 || data.busy) {
                        error.busy = true;
                        error.retryAfterMs = Number(data.retryAfterMs) || 0;
                        error.statusCode = 409;
                    }
                    return reject(error);
                }
                resolve(data.data || {});
            });
        });
        req.on('timeout', () => req.destroy(new Error('QQ 登录桥接请求超时')));
        req.on('error', (error) => reject(new Error(`QQ 登录桥接不可用: ${error.message}`)));
        if (payload)
            req.write(payload);
        req.end();
    });
}
// NapCat 是全局单例（一个 qrcode.png / 一份 session-home / 一个 QQ 进程），
// 多人同时扫会互相打死会话。owner 用于在桥接侧做租约归属校验，
// 调用方必须传入稳定的用户标识（面板用户名），后台无人值守任务传 system:*。
function withOwner(path, owner) {
    const value = String(owner || '').trim();
    if (!value)
        return path;
    return `${path}?owner=${encodeURIComponent(value)}`;
}
module.exports = {
    getNapCatQrCode: (owner = '') => requestBridge('GET', withOwner('/qrcode', owner), null, 70000),
    refreshNapCatQrCode: (owner = '') => requestBridge('POST', withOwner('/refresh', owner), {}, 70000),
    // 无副作用：供前端 2s 轮询“扫没扫”。绝不能用 /qrcode 轮询，
    // 后者会拉起/重启会话，把用户正在扫的会话打死。
    // 带上 owner 还有两个作用：持有者靠轮询续租；非持有者不会看到别人的登录态。
    getNapCatLoginStatus: (owner = '') => requestBridge('GET', withOwner('/status', owner), null, 10000),
    // 无副作用：只读当前 qrcode.png。NapCat 自己每 ~122s 重写该文件轮换二维码，
    // 前端靠 updatedAt 变化拉这个接口跟随换图。
    getNapCatQrImage: (owner = '') => requestBridge('GET', withOwner('/image', owner), null, 10000),
    authorizeNapCatFarm: (uin = '', owner = '') => requestBridge('POST', '/authorize', { uin, owner }, 90000),
    // 关页面/切走时主动交回扫码租约，不靠空闲超时硬等，下一个人立刻能扫。
    // 失败不影响业务（大不了等空闲超时），调用方可以安心吞错。
    releaseNapCatScanLease: (owner = '') => requestBridge('POST', '/release', { owner }, 5000),
    // 页面从后台恢复时软重新占用（不换码、不重启会话）。
    // 搭配 /release 使用：pagehide 交回 → pageshow 拿回，避免手机切到 QQ 扫码时丢租约。
    reclaimNapCatScanLease: (owner = '') => requestBridge('POST', '/reclaim', { owner }, 8000),
    checkNapCatBridge: () => requestBridge('GET', '/health', null, 5000),
};
//# sourceMappingURL=napcat-bridge-client.js.map