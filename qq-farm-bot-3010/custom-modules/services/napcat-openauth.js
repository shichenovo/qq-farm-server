"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { execFile, spawn } = require('node:child_process');
const fetch = require('node-fetch');
const NAPCAT_FARM_APP_ID = '1112386029';
const NAPCAT_OPEN_AUTH_ACTION = `start_mini_app_${NAPCAT_FARM_APP_ID}`;
const NAPCAT_SYSTEMD_UNIT = 'napcat-shell.service';
// All NapCat state lives under one root so the same code can run against the
// host layout (/opt/napcat-docker) or a container volume (/app/napcat-data).
const NAPCAT_WORKDIR = String(process.env.NAPCAT_WORKDIR || '/opt/napcat-docker');
const NAPCAT_CONFIG_DIR = path.join(NAPCAT_WORKDIR, 'config');
const NAPCAT_QR_IMAGE_PATH = process.env.NAPCAT_QR_IMAGE_PATH || path.join(NAPCAT_WORKDIR, 'cache', 'qrcode.png');
const NAPCAT_PID_FILE = process.env.NAPCAT_PID_FILE || '/run/qqfarm-napcat.pid';
const NAPCAT_SESSION_HOME = path.join(NAPCAT_WORKDIR, 'session-home');
const NAPCAT_QUICK_LOGIN_ROOT = path.join(NAPCAT_WORKDIR, 'quick-login-profiles');
// 'systemd' drives the host user unit (legacy layout). 'process' spawns the
// launcher directly, which is what the container uses since it has no systemd.
const NAPCAT_LAUNCH_MODE = String(process.env.NAPCAT_LAUNCH_MODE || 'systemd').toLowerCase();
const NAPCAT_LAUNCHER = String(process.env.NAPCAT_LAUNCHER || '');
// 常驻模式：授权结束后保留 QQ 在线，不回收进程、不删 session-home。
// 按需拉起模式下，每次刷新 Code 都要冷启动一个 QQ 并赌快速登录能成，
// 而冷启动链路很脆（版本目录缺文件、会话被回收都会退回二维码）。
// 常驻之后刷新 Code 就是在已在线的会话上直接调 OpenAuth，秒级完成。
//
// 默认开启：这是「扫码登录一次 → 长期在线 → 掉线自动补 Code」这条链路的前提，
// 不打开的话无人值守刷新基本不可用。要退回「按需拉起、用完即关」的老行为，
// 显式设 NAPCAT_KEEP_SESSION=0 即可（写法与 FARM_AUTOSTART_ACCOUNTS 保持一致）。
const NAPCAT_KEEP_SESSION = !/^(0|false|no|off)$/i.test(String(process.env.NAPCAT_KEEP_SESSION ?? '1').trim());
const USER_SYSTEMD_ENV = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/0',
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/0/bus',
};
const runtimeState = { lastActionAt: 0, lastActionOk: false, lastErrorStage: '' };
function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 15000, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
async function runUserSystemctl(args) {
    return runCommand('/bin/systemctl', ['--user', ...args], { env: USER_SYSTEMD_ENV });
}
function readLauncherPid() {
    try {
        const pid = Number(String(fs.readFileSync(NAPCAT_PID_FILE, 'utf8')).trim());
        return Number.isInteger(pid) && pid > 1 ? pid : 0;
    }
    catch (_) {
        return 0;
    }
}
function isLauncherPidAlive(pid) {
    if (!pid)
        return false;
    try {
        // Confirm the PID is still our QQ launcher and not a recycled unrelated
        // process before reporting busy or sending any signal to it.
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        return /(^|[\s/])qq(\s|$)/.test(cmdline) || cmdline.includes('launch-qq.sh');
    }
    catch (_) {
        return false;
    }
}
async function isTemporaryNapCatServiceActive() {
    if (NAPCAT_LAUNCH_MODE === 'process')
        return isLauncherPidAlive(readLauncherPid());
    try {
        await runUserSystemctl(['is-active', '--quiet', NAPCAT_SYSTEMD_UNIT]);
        return true;
    }
    catch (_) {
        return false;
    }
}
async function startLauncherProcess() {
    if (!NAPCAT_LAUNCHER)
        throw new Error('NAPCAT_LAUNCHER is not configured');
    fs.mkdirSync(path.join(NAPCAT_WORKDIR, 'logs'), { recursive: true });
    const logPath = path.join(NAPCAT_WORKDIR, 'logs', 'napcat-launcher.log');
    const logFd = fs.openSync(logPath, 'a');
    try {
        const child = spawn(NAPCAT_LAUNCHER, [], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, NAPCAT_WORKDIR },
        });
        child.unref();
        if (!child.pid)
            throw new Error('failed to spawn NapCat launcher');
        fs.mkdirSync(path.dirname(NAPCAT_PID_FILE), { recursive: true });
        fs.writeFileSync(NAPCAT_PID_FILE, String(child.pid));
    }
    finally {
        fs.closeSync(logFd);
    }
}
async function stopLauncherProcess() {
    const pid = readLauncherPid();
    if (!isLauncherPidAlive(pid)) {
        try {
            fs.unlinkSync(NAPCAT_PID_FILE);
        }
        catch (_) { }
        return;
    }
    // The launcher is spawned detached, so it leads its own process group.
    // Signalling the group reaps the Electron children too.
    try {
        process.kill(-pid, 'SIGTERM');
    }
    catch (_) {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch (_) { }
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (!isLauncherPidAlive(pid))
            break;
        await sleep(250);
    }
    if (isLauncherPidAlive(pid)) {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch (_) {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch (_) { }
        }
    }
    try {
        fs.unlinkSync(NAPCAT_PID_FILE);
    }
    catch (_) { }
}
function normalizeUin(uin) {
    const value = String(uin || '').trim();
    if (!/^\d{5,20}$/.test(value))
        throw new Error('invalid QQ account identifier');
    return value;
}
function quickLoginProfilePath(uin) {
    return path.join(NAPCAT_QUICK_LOGIN_ROOT, normalizeUin(uin));
}
function sessionQQConfigPath() {
    return path.join(NAPCAT_SESSION_HOME, '.config', 'QQ');
}
async function startTemporaryNapCat(options = {}) {
    const quickUin = options.quickUin ? normalizeUin(options.quickUin) : '';
    if (await isTemporaryNapCatServiceActive()) {
        if (quickUin)
            throw new Error('temporary QQ authorizer is busy');
        return { started: false, starting: true };
    }
    if (quickUin) {
        const profilePath = quickLoginProfilePath(quickUin);
        if (!fs.existsSync(profilePath))
            throw new Error('该 QQ 尚未保存快速登录资料，请先扫码授权一次');
        fs.rmSync(NAPCAT_SESSION_HOME, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(sessionQQConfigPath()), { recursive: true });
        fs.cpSync(profilePath, sessionQQConfigPath(), { recursive: true });
    }
    else {
        try {
            fs.unlinkSync(NAPCAT_QR_IMAGE_PATH);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    if (NAPCAT_LAUNCH_MODE === 'process')
        await startLauncherProcess();
    else
        await runUserSystemctl(['start', NAPCAT_SYSTEMD_UNIT]);
    return { started: true, starting: true, quickUin: quickUin || undefined };
}
async function stopTemporaryNapCat(options = {}) {
    const cacheUin = options.cacheUin ? normalizeUin(options.cacheUin) : '';
    // Only save a profile after verifying that the temporary authorizer really
    // logged into that same QQ. Never overwrite a saved quick-login profile
    // with an unauthenticated QR session or the wrong QQ's session.
    let canCacheProfile = false;
    if (cacheUin) {
        try {
            const profile = await getNapCatLoginProfile();
            canCacheProfile = profile.uin === cacheUin;
        }
        catch (_) { }
    }
    // 常驻模式：会话要留着给下一次刷新 Code 用。
    // 只在资料缺失时补存一份（拷贝一套 QQ 数据要上百 MB，没必要每轮都拷），
    // 既不 kill 进程也不删 session-home。
    //
    // 前提是「这个会话真的登录着」。没登录时留着它毫无意义，反而会让
    // 「刷新二维码」退化成：删掉旧码 → 会话还在所以不会重启 → 干等 NapCat
    // 下一轮约 122s 的换码周期，前端只能拿到一句 20s 超时。
    // 所以未登录（拿不到 uin）时照常回收，让它真正重启并立刻出一张新码。
    if (NAPCAT_KEEP_SESSION && cacheUin && canCacheProfile) {
        if (cacheUin && canCacheProfile) {
            const target = quickLoginProfilePath(cacheUin);
            if (!fs.existsSync(target)) {
                try {
                    const source = sessionQQConfigPath();
                    if (fs.existsSync(source)) {
                        fs.rmSync(target, { recursive: true, force: true });
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.cpSync(source, target, { recursive: true });
                    }
                }
                catch (_) { }
            }
        }
        return { stopped: false, keepSession: true };
    }
    // Service-managed sessions stop cleanly. The PID fallback retires the
    // pre-existing detached launcher during this migration only.
    if (NAPCAT_LAUNCH_MODE === 'process') {
        await stopLauncherProcess();
    }
    else {
        try {
            await runUserSystemctl(['stop', NAPCAT_SYSTEMD_UNIT]);
        }
        catch (_) { }
    }
    if (cacheUin && canCacheProfile) {
        try {
            const source = sessionQQConfigPath();
            if (fs.existsSync(source)) {
                const target = quickLoginProfilePath(cacheUin);
                fs.rmSync(target, { recursive: true, force: true });
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.cpSync(source, target, { recursive: true });
            }
        }
        catch (_) { }
    }
    // This directory belongs only to the temporary authorizer. Removing it
    // makes a manual add-account flow show a new QR; saved per-QQ profiles are
    // retained separately above for unattended Code refreshes.
    try {
        fs.rmSync(NAPCAT_SESSION_HOME, { recursive: true, force: true });
    }
    catch (_) { }
    // Process mode already reaped the launcher and its group above; the legacy
    // host-only PID sweep below must not run against a container PID namespace.
    if (NAPCAT_LAUNCH_MODE === 'process')
        return { stopped: true, legacySession: false };
    let pid = 0;
    try {
        pid = Number(fs.readFileSync(NAPCAT_PID_FILE, 'utf8').trim());
    }
    catch (_) { }
    if (!Number.isInteger(pid) || pid <= 1)
        return { stopped: true, legacySession: false };
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        const isNapCatLauncher = cmdline.includes('/opt/napcat-shell')
            && (cmdline.includes('xvfb-run') || cmdline.includes('/qq '));
        if (!isNapCatLauncher)
            return { stopped: true, legacySession: false };
        // Never signal the OpenClaw gateway: only the known launcher and direct children.
        try {
            await runCommand('/usr/bin/pkill', ['-TERM', '-P', String(pid)]);
        }
        catch (_) { }
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch (_) { }
        try {
            fs.unlinkSync(NAPCAT_PID_FILE);
        }
        catch (_) { }
        return { stopped: true, legacySession: true };
    }
    catch (_) {
        return { stopped: true, legacySession: false };
    }
}
function getWebUiConfigCandidates() {
    const candidates = [];
    const add = (value) => {
        const file = String(value || '').trim();
        if (file && !candidates.includes(file))
            candidates.push(file);
    };
    add(process.env.NAPCAT_WEBUI_CONFIG);
    try {
        for (const entry of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(entry))
                continue;
            try {
                const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
                if (!/(^|\s)(\.\/)?qq(\s|$)/.test(cmdline))
                    continue;
                add(path.join(fs.readlinkSync(`/proc/${entry}/cwd`), 'config', 'webui.json'));
            }
            catch (_) { }
        }
    }
    catch (_) { }
    add(path.join(NAPCAT_CONFIG_DIR, 'webui.json'));
    add('/app/napcat/config/webui.json');
    add('/opt/napcat-shell/config/webui.json');
    add('/opt/napcat-shell.bak-20260709093049/config/webui.json');
    add('/opt/napcat-docker/config/webui.json');
    return candidates;
}
async function postJson(url, body, headers = {}, timeout = Number(process.env.NAPCAT_TIMEOUT_MS) || 8000) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body || {}),
        timeout,
    });
    let json = null;
    try {
        json = await response.json();
    }
    catch (_) {
        throw new Error(`NapCat HTTP ${response.status} returned non-JSON`);
    }
    if (!response.ok)
        throw new Error(`NapCat HTTP ${response.status}`);
    return json;
}
// 【2026-08-19】运行时解析结果必须缓存。
// getNapCatRuntimeOneBot() 原本每次调用都重新跑一遍 WebUI /api/auth/login，
// 而前端 2s 轮询登录状态会链式调到这里 → 两分钟就是几十次登录，
// NapCat 直接回 {"code":-1,"message":"login rate limit"}。
// 缓存本身就是限流的正解；切记不要再加“全局冷却并直接抛错”，
// 那会把瞬时限流升级成硬失败，连快速登录一起卡死（已踩过这个坑）。
let runtimeCache = { value: null, at: 0 };
const RUNTIME_CACHE_TTL_MS = Number(process.env.NAPCAT_RUNTIME_CACHE_TTL_MS) || 60000;
function invalidateNapCatRuntimeCache() {
    runtimeCache = { value: null, at: 0 };
}
// 直接读 NapCat 本地 onebot11*.json 并探测 /get_login_info。
// 这条路完全不碰 WebUI，因此不会触发登录限流；只要会话已登录就能成功。
async function probeLocalOneBotRuntime() {
    try {
        const configuredBase = new URL(String(process.env.NAPCAT_BASE_URL || 'http://127.0.0.1:3001'));
        const configDir = NAPCAT_CONFIG_DIR;
        const files = fs.existsSync(configDir) ? fs.readdirSync(configDir).filter(name => /^onebot11.*\.json$/i.test(name)) : [];
        for (const name of files) {
            try {
                const cfg = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
                const servers = Array.isArray(cfg?.network?.httpServers) ? cfg.network.httpServers : [];
                const server = servers.find(item => item && item.enable !== false && Number(item.port) === Number(configuredBase.port || 3001));
                if (!server)
                    continue;
                const oneBotBaseUrl = `${configuredBase.protocol}//${configuredBase.hostname}:${server.port}`;
                const oneBotToken = String(server.token || '');
                const probeHeaders = oneBotToken ? { Authorization: `Bearer ${oneBotToken}` } : {};
                const probe = await postJson(`${oneBotBaseUrl}/get_login_info`, {}, probeHeaders);
                if (Number(probe?.retcode) === 0)
                    return { oneBotBaseUrl, oneBotToken };
            }
            catch (_) { }
        }
    }
    catch (_) { }
    return null;
}
async function getNapCatRuntimeOneBot() {
    if (runtimeCache.value && Date.now() - runtimeCache.at < RUNTIME_CACHE_TTL_MS) {
        return runtimeCache.value;
    }
    // 先走零成本的本地探测，避免把 WebUI 登录打到限流
    const local = await probeLocalOneBotRuntime();
    if (local) {
        runtimeCache = { value: local, at: Date.now() };
        return local;
    }
    const webUiBase = String(process.env.NAPCAT_WEBUI_BASE_URL || 'http://127.0.0.1:6099').replace(/\/+$/, '');
    let lastError = null;
    for (const configPath of getWebUiConfigCandidates()) {
        try {
            if (!fs.existsSync(configPath))
                continue;
            const webUiConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const webUiToken = String(webUiConfig.token || '');
            if (!webUiToken)
                continue;
            const hash = crypto.createHash('sha256').update(`${webUiToken}.napcat`).digest('hex');
            const login = await postJson(`${webUiBase}/api/auth/login`, { hash });
            const credential = String(login?.data?.Credential || '');
            // 限流是瞬时的（实测：同一秒重试即返回 code:0），
            // 只当作本次失败往下走降级路径，绝不设全局冷却。
            if (login?.code !== 0 || !credential) {
                throw new Error(/rate limit/i.test(String(login?.message || ''))
                    ? 'NapCat WebUI 登录瞬时限流（login rate limit）'
                    : 'WebUI authentication failed');
            }
            const obConfig = await postJson(`${webUiBase}/api/OB11Config/GetConfig`, {}, { Authorization: `Bearer ${credential}` });
            const servers = Array.isArray(obConfig?.data?.network?.httpServers) ? obConfig.data.network.httpServers : [];
            const configuredBase = new URL(String(process.env.NAPCAT_BASE_URL || 'http://127.0.0.1:3001'));
            const configuredPort = Number(configuredBase.port || (configuredBase.protocol === 'https:' ? 443 : 80));
            const httpServer = servers.find(item => item && item.enable !== false && Number(item.port) === configuredPort)
                || servers.find(item => item && item.enable !== false);
            const oneBotToken = String(httpServer?.token || '');
            if (!httpServer)
                throw new Error('OneBot HTTP server missing');
            const resolved = { oneBotBaseUrl: `${configuredBase.protocol}//${configuredBase.hostname}:${httpServer.port}`, oneBotToken };
            runtimeCache = { value: resolved, at: Date.now() };
            return resolved;
        }
        catch (e) {
            lastError = e;
        }
    }
    throw new Error(lastError?.message || 'NapCat WebUI runtime authentication unavailable');
}
async function requestNapCatFarmAuthorization() {
    const runtime = await getNapCatRuntimeOneBot();
    try {
        const headers = runtime.oneBotToken ? { Authorization: `Bearer ${runtime.oneBotToken}` } : {};
        const actionUrl = `${runtime.oneBotBaseUrl}/${NAPCAT_OPEN_AUTH_ACTION}`;
        let lastError = null;
        // Restored quick-login sessions can report logged-in before the mini-app
        // authorization bridge is ready. Retry the two supported actions briefly
        // instead of treating the first empty result as a permanent failure.
        for (let attempt = 1; attempt <= 3; attempt++) {
            // 新版 NapCat/QQ 的返回结构可能与旧版不同，多试一个 __open_auth__ 兜底。
            for (const path of ['__open_code__', '__login_with_appid__', '__open_auth__']) {
                try {
                    // 超时必须大于补丁内部的 30s 超时：否则这里 8s（默认）就先掐断
                    // 连接，拿回一个 fetch 的网络错误，把 NapCat 的真实回包盖掉。
                    const response = await postJson(actionUrl, { path }, headers, 40000);
                    const outer = response?.data?.result || {};
                    // action 返回的形状是 { operation, result }，真正的业务值在 result 里。
                    const inner = outer && typeof outer === 'object' && 'result' in outer
                        ? outer.result
                        : outer;
                    // 只认字符串或对象里的明确字段。原先直接 String(对象) 会把
                    // { timeout: true } 之类变成 "[object Object]" 当成有效 Code 用下去，
                    // 后面才在别处炸出更费解的错误。
                    let accessToken = '';
                    if (typeof inner === 'string') {
                        accessToken = inner.trim();
                    }
                    else if (inner && typeof inner === 'object') {
                        accessToken = String(inner.code || inner.openCode || inner.authCode
                            || inner.accessToken || inner.token || inner.openAuthCode || '').trim();
                    }
                    // openId 同样可能藏在内层
                    const idSource = inner && typeof inner === 'object' ? inner : outer;
                    const openId = String(idSource?.openId || idSource?.openID || '');
                    const resultCode = Number(inner?.errorCode ?? inner?.errCode
                        ?? outer?.errorCode ?? outer?.errCode ?? 0);
                    if (response?.retcode === 0 && resultCode === 0 && accessToken) {
                        runtimeState.lastActionAt = Date.now();
                        runtimeState.lastActionOk = true;
                        runtimeState.lastErrorStage = '';
                        return {
                            code: accessToken,
                            openID: openId,
                            expiresAt: Number(inner?.expiresAt || inner?.expireAt || inner?.expireTime || 0) || null,
                        };
                    }
                    // 把原始返回带进错误信息：看不到 NapCat 到底回了什么，
                    // 就只能靠猜（QQ 3.2.29 → 3.2.30 之后返回结构变过）。
                    // 要把 OneBot 的完整回包带上：只看 data.result 会在 data 为 null
                    // 时退化成一个 {}，把「action 不存在 / 参数错误 / 内部异常」
                    // 这些真正的原因全吞掉。retcode 与 message 才是判断依据。
                    const raw = (() => {
                        try {
                            return JSON.stringify({
                                retcode: response?.retcode,
                                status: response?.status,
                                message: response?.message ?? response?.wording ?? '',
                                data: response?.data,
                            }).slice(0, 300);
                        }
                        catch {
                            return String(response).slice(0, 300);
                        }
                    })();
                    lastError = new Error(`NapCat ${path} returned no usable Code (raw: ${raw})`);
                }
                catch (error) {
                    lastError = error;
                }
            }
            if (attempt < 3)
                await sleep(attempt * 1500);
        }
        // 三条路都走空了就别再猜了：直接问 NapCat 要 NodeMiscService 的真实方法清单。
        // 补丁里的 __inspect__ 探针会回 nodeMiscMethods 与几个关键方法的签名，
        // 把它并进错误信息，一次失败就能看清是「方法没了」还是「返回值结构变了」。
        if (lastError) {
            try {
                const inspect = await postJson(actionUrl, { path: '__inspect__' }, headers, 20000);
                lastError.message += ` | inspect: ${JSON.stringify(inspect?.data ?? inspect).slice(0, 900)}`;
            }
            catch (inspectError) {
                lastError.message += ` | inspect failed: ${inspectError.message}`;
            }
        }
        throw lastError || new Error('NapCat farm authorization failed');
    }
    catch (e) {
        runtimeState.lastActionAt = Date.now();
        runtimeState.lastActionOk = false;
        runtimeState.lastErrorStage = 'open_auth_action';
        throw e;
    }
}
async function getNapCatLoginProfile() {
    const runtime = await getNapCatRuntimeOneBot();
    const headers = runtime.oneBotToken ? { Authorization: `Bearer ${runtime.oneBotToken}` } : {};
    const response = await postJson(`${runtime.oneBotBaseUrl}/get_login_info`, {}, headers);
    const data = response?.data || {};
    const uin = String(data.user_id || data.uin || data.qq || '').trim();
    const nickname = String(data.nickname || data.nick || '').trim();
    return {
        uin,
        nickname,
        avatar: uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=640` : '',
    };
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function requestQuickLogin(uin) {
    const configPath = getWebUiConfigCandidates().find(file => {
        try {
            return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token;
        }
        catch (_) {
            return false;
        }
    });
    if (!configPath)
        throw new Error('NapCat WebUI config not found');
    const webUiConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const webUiToken = String(webUiConfig.token || '');
    const hash = crypto.createHash('sha256').update(`${webUiToken}.napcat`).digest('hex');
    const base = String(process.env.NAPCAT_WEBUI_BASE_URL || 'http://127.0.0.1:6099').replace(/\/+$/, '');
    let lastError = null;
    // WebUI 会在 QQ 刚启动的几秒内还没准备好；限流时也要退避，不能连续猛打。
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            const login = await postJson(`${base}/api/auth/login`, { hash }, {}, 5000);
            const credential = String(login?.data?.Credential || '');
            if (login?.code !== 0 || !credential)
                throw new Error(/rate limit/i.test(String(login?.message || ''))
                    ? 'NapCat WebUI 登录限流' : 'NapCat WebUI authentication failed');
            const result = await postJson(`${base}/api/QQLogin/SetQuickLogin`, { uin }, { Authorization: `Bearer ${credential}` }, 5000);
            if (result?.code !== 0)
                throw new Error(result?.message || 'NapCat quick login failed');
            return;
        }
        catch (error) {
            lastError = error;
            await sleep(Math.min(3000, 500 + attempt * 400));
        }
    }
    throw lastError || new Error('NapCat WebUI authentication failed');
}
async function ensureTemporaryNapCatForUin(uin) {
    const targetUin = normalizeUin(uin);
    // The temporary authorizer is single-account. Replace any QR/manual
    // session with this account's saved quick-login profile.
    if (await isTemporaryNapCatServiceActive()) {
        await stopTemporaryNapCat();
    }
    await startTemporaryNapCat({ quickUin: targetUin });
    const deadline = Date.now() + 60000;
    let lastError = null;
    let nextQuickLoginAt = Date.now();
    while (Date.now() < deadline) {
        try {
            const runtime = await getNapCatRuntimeOneBot();
            const profile = await getNapCatLoginProfile();
            if (profile.uin === targetUin)
                return runtime;
            lastError = new Error(`临时授权器登录 QQ 不匹配（当前 ${profile.uin || '未登录'}，目标 ${targetUin}）`);
        }
        catch (e) {
            lastError = e;
        }
        // The restored profile is the source of the quick-login parameters.
        // Once NapCat WebUI is ready, actively select this UIN. Retry because
        // WebUI may be listening before its authentication service is ready.
        if (Date.now() >= nextQuickLoginAt) {
            try {
                await requestQuickLogin(targetUin);
                nextQuickLoginAt = Date.now() + 5000;
            }
            catch (e) {
                lastError = e;
                nextQuickLoginAt = Date.now() + 1500;
            }
        }
        await sleep(1000);
    }
    throw new Error(lastError?.message || 'NapCat 快速登录超时');
}
function getNapCatRuntimeState() {
    return { ...runtimeState };
}
module.exports = {
    NAPCAT_FARM_APP_ID,
    NAPCAT_OPEN_AUTH_ACTION,
    isTemporaryNapCatServiceActive,
    invalidateNapCatRuntimeCache,
    getNapCatRuntimeOneBot,
    requestNapCatFarmAuthorization,
    getNapCatLoginProfile,
    getNapCatRuntimeState,
    startTemporaryNapCat,
    stopTemporaryNapCat,
    ensureTemporaryNapCatForUin,
};
//# sourceMappingURL=napcat-openauth.js.map