#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

// ===== 双通道隔离：主实例 / 扫码实例 =====
//
// 背景（2026-08-31）：NapCat 在容器里是全局单例——一份 workdir、一个 onebot 端口、
// 一个 WebUI 端口、一个 PID 文件、一个 QQ 进程。于是两类使用者必然互踩：
//   · 后台无人值守任务（owner = system:*）：掉线自动重连、定时刷新 Code，
//     需要一个长期在线的 QQ 会话（KEEP_SESSION=1 常驻）。
//   · 真人扫码（owner = token:*）：取码要 stop → 删旧码 → start，
//     会把上面那个在线会话当场打死。
// 曾经的调和手段是「租约 + 15 秒后重试」，但那只做到了互斥，没做到隔离：
// 系统重连占着租约时真人被拒三次（每次提示等 15 秒），真人扫码时系统任务
// 反过来报「另一位用户正在扫码授权 QQ」，两边都在刷错误日志。
//
// 现在的做法：把单例拆成两个互不相干的实例，各走各的通道。
//   · main 通道 → 主实例：workdir /app/napcat-data、onebot 3001、WebUI 6099、X :1
//     只服务 system:*，QQ 常驻在线，刷新 Code 是秒级的。
//   · scan 通道 → 扫码实例：workdir /app/napcat-scan、onebot 3101、WebUI 6199、X :2
//     只服务真人扫码，QQ 按需拉起、用完即回收，不碰主实例的会话。
// 两条通道各有独立租约，因此「有人扫码时另开一个 QQ 实例」与
// 「后台自动重连」可以同时进行，谁也不用等谁。
//
// 为什么是「容器内第二个实例」而不是「新起一个 Docker 容器」：
//   这台宿主机只有 1.7GB 内存，一个 QQ(Electron) 常驻约 300MB，起第二个容器的
//   内存开销与第二个进程基本相同，却还要额外挂载 docker.sock（等同给容器 root）、
//   改 compose、重启 napcat-farm（会打断当前登录态）。按 workdir + 端口 + X 显示
//   隔离同样能拿到干净的会话边界，代价小得多。
const OPENAUTH_PATH = require.resolve('../core/src/services/napcat-openauth');

const MAIN_WORKDIR = process.env.NAPCAT_WORKDIR || '/opt/napcat-docker';
const MAIN_ONEBOT_URL = process.env.NAPCAT_BASE_URL || 'http://127.0.0.1:3001';
const MAIN_WEBUI_URL = process.env.NAPCAT_WEBUI_BASE_URL || 'http://127.0.0.1:6099';
const MAIN_PID_FILE = process.env.NAPCAT_PID_FILE || '/run/qqfarm-napcat.pid';
const MAIN_DISPLAY = process.env.NAPCAT_DISPLAY || process.env.DISPLAY || ':1';

const SCAN_WORKDIR = process.env.NAPCAT_SCAN_WORKDIR || '/app/napcat-scan';
const SCAN_ONEBOT_PORT = Number(process.env.NAPCAT_SCAN_ONEBOT_PORT) || 3101;
const SCAN_WEBUI_PORT = Number(process.env.NAPCAT_SCAN_WEBUI_PORT) || 6199;
const SCAN_PID_FILE = process.env.NAPCAT_SCAN_PID_FILE || '/run/qqfarm-napcat-scan.pid';
const SCAN_DISPLAY = process.env.NAPCAT_SCAN_DISPLAY || ':2';
// 一键回退：出问题就设 NAPCAT_SCAN_ISOLATION=0，退回所有人共用主实例的老行为。
const SCAN_ISOLATION = !/^(0|false|no|off)$/i.test(String(process.env.NAPCAT_SCAN_ISOLATION ?? '1').trim());
// 内存保护：扫码实例要再吃 ~300MB。可用内存低于此值就不开独立实例，
// 直接降级到主实例——宁可让扫码排队，也绝不把已在线的账号 OOM 掉
// （1.7GB 的机器上这是真会发生的，而且表现就是「农场账号莫名掉线」）。
const SCAN_MIN_MEM_MB = Number(process.env.NAPCAT_SCAN_MIN_MEM_MB) || 320;
// 扫码实例空闲多久后回收 QQ 进程（省内存）。租约一放就开始计时。
const SCAN_RECLAIM_IDLE_MS = Number(process.env.NAPCAT_SCAN_RECLAIM_IDLE_MS) || 60000;

const SOCKET_PATH = process.env.NAPCAT_BRIDGE_SOCKET || '/run/qqfarm-napcat-bridge.sock';
// QR 路径必须跟 napcat-openauth.js 用同一套推导（NAPCAT_WORKDIR/cache/qrcode.png）。
// 曾经这里硬编码宿主布局 /opt/napcat-docker，容器里 NapCat 明明已经把二维码写到
// /app/napcat-data/cache 了，bridge 却一直等一个不存在的文件 → 「二维码生成超时」。
// 冷启动要先拉起 Electron + 等网络就绪，15s 在慢盘上不够。
const QR_TIMEOUT_MS = Number(process.env.NAPCAT_QR_TIMEOUT_MS) || 45000;

// ===== 二维码解码 URL（用于前端重新生成高清码）=====
// 背景：NapCat 写出的 qrcode.png 只有 147×147，内含 41×41 个模块 → 每模块仅 3px，
// 且白边只有 4 个模块。浏览器把它拉伸到 192 CSS px 显示时插值把模块边缘糊掉，
// 于是「长按识别二维码」这种截图解码路径认不出来（摄像头对着物理屏幕多帧采样反而没事）。
// 结果是用手机开面板的单设备用户无法扫码 —— 他既不能长按识别，也没法用摄像头扫自己屏幕。
// NapCat 的 launcher 日志里同时打印了这张码的原始内容（`二维码解码URL: https://txz.qq.com/p?k=...`），
// 把它透给前端，由浏览器用原始数据重新编码一张模块 10px 的码，属于无损重建，不存在放大失真。
//
// 【安全】这个 URL 等价于登录凭据：谁拿到谁能完成授权。所以它只能跟着
// readQr() 走 /qrcode、/refresh、/image 这三个**已按 owner 校验租约**的出口下发，
// 绝不能出现在无副作用、非持有者也能读的 /status 里。
// 日志会长到几 MB，只读尾部。一轮换码之间的 ASCII art 约 1~2KB，256KB 足够覆盖。
const QR_LOG_TAIL_BYTES = Number(process.env.NAPCAT_QR_LOG_TAIL_BYTES) || 262144;
// 只有当日志里「已保存到 qrcode.png」的时间戳与文件 mtime 足够接近时，才认为这条 URL
// 对应的就是当前这张图。否则宁可不下发（前端自动退回原始 PNG），
// 也绝不能把上一轮的旧 URL 当成当前码发出去 —— 那等于把别人的登录码交给用户。
const QR_URL_MATCH_TOLERANCE_MS = Number(process.env.NAPCAT_QR_URL_TOLERANCE_MS) || 20000;
// 【重要】2026-08-19 实测 launcher.log 确认：NapCat **自己就会在同一会话内
// 每 ~122 秒原地重写 qrcode.png 轮换二维码**（例：10:27:55 冷启动后，
// 10:29:57 / 10:31:59 / ... / 10:48:14 均无冷启动而自行换码）。
// 所以绝不能在这里自己搞“二维码过期就 stop+start”：
// 一旦阈值小于轮换周期，就会把用户正在扫的会话反复打死（已踩过这个坑）。
// 会话活着就直接读当前文件，让 NapCat 自己负责新鲜度。

/**
 * 加载一份独立配置的 napcat-openauth。
 *
 * 该模块的所有路径/端口都是 require 时求值的模块级常量，所以
 * 「清 require 缓存 → 临时改 env → 重新 require → 还原 env」
 * 就能拿到一份完全隔离的实例，不必把 633 行源码重构成工厂函数。
 * 返回的对象在 env 还原后依然持有自己那份常量闭包，互不干扰。
 */
function loadOpenAuth(overrides) {
    const key = OPENAUTH_PATH;
    const saved = new Map();
    for (const [name, value] of Object.entries(overrides || {})) {
        saved.set(name, process.env[name]);
        if (value === undefined) delete process.env[name];
        else process.env[name] = String(value);
    }
    delete require.cache[key];
    let mod;
    try {
        mod = require(key);
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        // 顺手清掉，避免后续任何一处 require 拿到「上一份配置」的半成品。
        delete require.cache[key];
    }
    return mod;
}

// 主实例：保持容器原本的 env（workdir /app/napcat-data、3001、6099、:1、KEEP_SESSION=1）
const mainAuth = loadOpenAuth({});
// 扫码实例：独立 workdir / 端口 / X 显示 / PID 文件。
// NAPCAT_KEEP_SESSION=0 是刻意的：扫码是一次性动作，用完必须回收进程，
// 否则第二个 Electron 会常驻吃掉 300MB，1.7GB 的机器上撑不住。
const scanAuth = SCAN_ISOLATION
    ? loadOpenAuth({
        NAPCAT_WORKDIR: SCAN_WORKDIR,
        NAPCAT_BASE_URL: `http://127.0.0.1:${SCAN_ONEBOT_PORT}`,
        NAPCAT_WEBUI_BASE_URL: `http://127.0.0.1:${SCAN_WEBUI_PORT}`,
        NAPCAT_PID_FILE: SCAN_PID_FILE,
        NAPCAT_DISPLAY: SCAN_DISPLAY,
        NAPCAT_QR_IMAGE_PATH: path.join(SCAN_WORKDIR, 'cache', 'qrcode.png'),
        NAPCAT_KEEP_SESSION: '0',
    })
    : mainAuth;

function makeChannel(name, auth, workdir, onebotUrl, webuiUrl, pidFile, display) {
    let onebotPort = 3001;
    try { onebotPort = Number(new URL(onebotUrl).port) || 3001; } catch { /* 保持默认 */ }
    return {
        name,
        auth,
        workdir,
        onebotPort,
        webuiUrl,
        pidFile,
        display,
        configDir: path.join(workdir, 'config'),
        qrPath: path.join(workdir, 'cache', 'qrcode.png'),
        logPath: path.join(workdir, 'logs', 'napcat-launcher.log'),
        // 每个实例一套串行队列：两个 QQ 互不干涉，不必共用一把锁。
        queue: Promise.resolve(),
    };
}

const CH = {
    main: makeChannel('main', mainAuth, MAIN_WORKDIR, MAIN_ONEBOT_URL, MAIN_WEBUI_URL, MAIN_PID_FILE, MAIN_DISPLAY),
    scan: SCAN_ISOLATION
        ? makeChannel('scan', scanAuth, SCAN_WORKDIR, `http://127.0.0.1:${SCAN_ONEBOT_PORT}`, `http://127.0.0.1:${SCAN_WEBUI_PORT}`, SCAN_PID_FILE, SCAN_DISPLAY)
        : makeChannel('main', mainAuth, MAIN_WORKDIR, MAIN_ONEBOT_URL, MAIN_WEBUI_URL, MAIN_PID_FILE, MAIN_DISPLAY),
};

function enqueue(ch, task) {
    const run = ch.queue.then(task, task);
    ch.queue = run.catch(() => {});
    return run;
}

// ===== 扫码实例的配套设施 =====
const MEM_CACHE_TTL_MS = 5000;
let memCache = { mb: 0, at: 0 };

function memAvailableMb() {
    if (memCache.mb && Date.now() - memCache.at < MEM_CACHE_TTL_MS) return memCache.mb;
    let mb = 0;
    try {
        const text = fs.readFileSync('/proc/meminfo', 'utf8');
        const matched = /MemAvailable:\s+(\d+)\s+kB/.exec(text);
        if (matched) mb = Math.floor(Number(matched[1]) / 1024);
    } catch { /* 读不到就当 0，走降级 */ }
    memCache = { mb, at: Date.now() };
    return mb;
}

// 扫码实例是否已就绪可被使用（隔离开关 + 内存预算）。
function scanChannelReady() {
    if (!SCAN_ISOLATION) return false;
    const mb = memAvailableMb();
    if (mb > 0 && mb < SCAN_MIN_MEM_MB) {
        console.log(`[扫码通道] 可用内存 ${mb}MB < ${SCAN_MIN_MEM_MB}MB，本轮降级到主实例`);
        return false;
    }
    return true;
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
}

// 给扫码实例铺一套自己的 NapCat 配置。
// 端口必须改成 3101/6199，否则它会去连主实例的 3001，
// 表现是「扫码实例明明登录了，bridge 却读到主实例那个 QQ 的资料」。
function ensureScanConfig() {
    if (!SCAN_ISOLATION) return;
    const dir = CH.scan.configDir;
    ensureDir(dir);
    ensureDir(path.join(SCAN_WORKDIR, 'cache'));
    ensureDir(path.join(SCAN_WORKDIR, 'logs'));

    // onebot11.json：NapCat 的 HTTP 服务端口，bridge 靠它拿登录态和调 OpenAuth。
    // 每次启动都重写（幂等），而不是「不存在才写」：
    // 默认模板里带着一个 3001，照抄会让扫码实例去监听主实例的端口——
    // 端口被占则 NapCat 起不来，更糟的是抢成功后两边数据串台。
    // 所以这里直接覆盖整份 httpServers，只留扫码实例自己的端口。
    const onebotFile = path.join(dir, 'onebot11.json');
    let onebot = null;
    try { onebot = JSON.parse(fs.readFileSync(onebotFile, 'utf8')); } catch { /* 还没有，用模板 */ }
    if (!onebot || typeof onebot !== 'object') {
        try { onebot = JSON.parse(fs.readFileSync('/app/napcat-defaults/config/onebot11.json', 'utf8')); } catch { /* 用兜底 */ }
    }
    if (!onebot || typeof onebot !== 'object') {
        onebot = { network: {}, musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false, imageDownloadProxy: '' };
    }
    if (!onebot.network || typeof onebot.network !== 'object') onebot.network = {};
    onebot.network.httpServers = [{
        host: '127.0.0.1', port: SCAN_ONEBOT_PORT, enable: true, enableCors: false,
        token: '', messagePostFormat: 'array', name: 'http-server',
        enableWebsocket: false, debug: false,
    }];
    try { fs.writeFileSync(onebotFile, `${JSON.stringify(onebot, null, 2)}\n`); } catch { /* 只读挂载时忽略 */ }

    // napcat.json：主配置，直接沿用官方默认（已存在就不动）
    const napcatFile = path.join(dir, 'napcat.json');
    if (!fs.existsSync(napcatFile)) {
        try {
            const defaults = JSON.parse(fs.readFileSync('/app/napcat-defaults/config/napcat.json', 'utf8'));
            fs.writeFileSync(napcatFile, `${JSON.stringify(defaults, null, 2)}\n`);
        } catch { /* 缺就用 NapCat 自己的默认值 */ }
    }

    // webui.json：token 复用主实例的（同一个 NapCat，换了端口而已），
    // 这样 requestQuickLogin 之类的 WebUI 调用在扫码实例上也能用。
    const webuiFile = path.join(dir, 'webui.json');
    let webui = null;
    try { webui = JSON.parse(fs.readFileSync(webuiFile, 'utf8')); } catch { /* 还没有 */ }
    if (!webui || typeof webui !== 'object') {
        try { webui = JSON.parse(fs.readFileSync(path.join(CH.main.configDir, 'webui.json'), 'utf8')); } catch { /* 主实例也没有 */ }
    }
    if (webui && typeof webui === 'object' && Number(webui.port) !== SCAN_WEBUI_PORT) {
        // 只改端口，token 原样保留（WebUI 凭据是 NapCat 自己生成的，不能编）
        webui.port = SCAN_WEBUI_PORT;
        try { fs.writeFileSync(webuiFile, `${JSON.stringify(webui, null, 2)}\n`); } catch { /* 只读挂载时忽略 */ }
    }
}

// 扫码实例跑在独立的 X 显示上：两个 Electron 挤同一个 :1 会互相干扰窗口/剪贴板。
// entrypoint 的 keep_xvfb_alive 只保活 :1，所以 :2 由 bridge 自己看着——
// 它挂了的话扫码实例根本起不来（Electron 无 X 显示会直接退出），
// 而且症状是「二维码生成超时」，很难一眼看出是显示器没了。
function displaySocketPath() {
    const num = String(SCAN_DISPLAY).replace(/^:/, '');
    return `/tmp/.X11-unix/X${num}`;
}

function displaySocketAlive() {
    try { return fs.existsSync(displaySocketPath()); } catch { return false; }
}

/**
 * Xvfb 进程是否真的在跑。
 *
 * 【踩过的坑】只看 socket 文件是不够的：docker restart 不会重置容器的可写层，
 * 上次运行留下的 /tmp/.X11-unix/X2 会一直躺在磁盘上，而 Xvfb 进程早就没了。
 * 于是「文件存在 = 显示器活着」这个判断恒为真，Xvfb 永远不会被重新拉起，
 * 扫码实例的 QQ 一启动就报
 *   ERROR:ozone_platform_x11.cc:256] Missing X server or $DISPLAY → 直接退出，
 * 表现就是「二维码生成超时」，极难看出是显示器的问题。
 * 所以必须扫 /proc 确认进程本体还在。
 */
function displayProcessAlive() {
    const target = String(SCAN_DISPLAY).trim();
    const pattern = new RegExp(`(^|\\s)${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    try {
        for (const entry of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(entry)) continue;
            let cmdline = '';
            try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
            if (cmdline.includes('Xvfb') && pattern.test(cmdline)) return true;
        }
    } catch { /* /proc 读不到就当没活着，交给下面的启动逻辑 */ }
    return false;
}

function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 退化成不等 */ }
}

function ensureScanDisplay() {
    if (!SCAN_ISOLATION) return;
    if (displayProcessAlive() && displaySocketAlive()) return;
    const num = String(SCAN_DISPLAY).replace(/^:/, '');
    try {
        // 先清残留锁/ socket：否则 Xvfb 会以 “Server is already active for display N” 立刻退出，
        // 而进程一退出又没人来清，形成「永远起不来」的死锁。
        try { fs.unlinkSync(`/tmp/.X${num}-lock`); } catch { /* 本来就没有 */ }
        try { fs.unlinkSync(displaySocketPath()); } catch { /* 本来就没有 */ }
        const child = spawn('Xvfb', [SCAN_DISPLAY, '-screen', '0', '1080x760x16', '+extension', 'GLX', '+render', '-nolisten', 'tcp'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        console.log(`[扫码通道] 已启动 Xvfb ${SCAN_DISPLAY}`);
        // 等 socket 真正出现：Xvfb 进程在 ≠ 显示可用，
        // 紧接着拉起 QQ 的话它会抢在 socket 建好之前去连，然后报 Missing X server。
        for (let i = 0; i < 20 && !displaySocketAlive(); i += 1) sleepSync(250);
        console.log(`[扫码通道] Xvfb ${SCAN_DISPLAY} socket ${displaySocketAlive() ? '就绪' : '未就绪，下轮巡检再试'}`);
    } catch (error) {
        console.log(`[扫码通道] Xvfb ${SCAN_DISPLAY} 启动失败: ${error.message}`);
    }
}

/**
 * 扫码授权成功后，把扫码实例的登录资料转存成主实例的快速登录资料。
 * 这样以后这个账号的掉线重连 / 定时刷新 Code 都走主实例（常驻、秒级），
 * 不需要再开扫码实例，也不必再麻烦用户扫第二次。
 */
function promoteScanProfileToMain(uin) {
    if (!SCAN_ISOLATION) return false;
    const clean = String(uin || '').trim();
    if (!/^\d{5,20}$/.test(clean)) return false;
    const source = path.join(SCAN_WORKDIR, 'session-home', '.config', 'QQ');
    const target = path.join(CH.main.workdir, 'quick-login-profiles', clean);
    if (!fs.existsSync(source)) return false;
    try {
        ensureDir(path.dirname(target));
        fs.rmSync(target, { recursive: true, force: true });
        fs.cpSync(source, target, { recursive: true });
        console.log(`[扫码通道] 已把 QQ ${clean} 的登录资料转存到主实例（后续自动重连走主实例）`);
        return true;
    } catch (error) {
        console.log(`[扫码通道] 登录资料转存失败（不影响本次授权）: ${error.message}`);
        return false;
    }
}

// NapCat 首次登录新 QQ 时可能生成空的 onebot11_<uin>.json；补齐本地 HTTP
// 服务，否则扫码虽然登录成功，bridge 仍识别不到登录态和农场 OpenAuth。
function ensureOneBotHttpConfigs(ch) {
    try {
        for (const name of fs.readdirSync(ch.configDir)) {
            if (!/^onebot11(?:_\d+)?\.json$/i.test(name)) continue;
            const file = path.join(ch.configDir, name);
            let config;
            try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
            if (!config || typeof config !== 'object') continue;
            if (!config.network || typeof config.network !== 'object') config.network = {};
            const servers = Array.isArray(config.network.httpServers) ? config.network.httpServers : [];
            if (servers.some(item => item && item.enable !== false && Number(item.port) === ch.onebotPort)) continue;
            config.network.httpServers = [{
                host: '127.0.0.1', port: ch.onebotPort, enable: true, enableCors: false,
                token: '', messagePostFormat: 'array', name: 'http-server',
                enableWebsocket: false, debug: false,
            }, ...servers.filter(Boolean)];
            try { fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`); } catch { /* 只读时忽略 */ }
        }
    } catch { /* config 目录还不存在，下次再来 */ }
}

ensureOneBotHttpConfigs(CH.main);
if (SCAN_ISOLATION) {
    ensureScanConfig();
    ensureScanDisplay();
    ensureOneBotHttpConfigs(CH.scan);
}
const oneBotConfigWatcher = setInterval(() => {
    ensureOneBotHttpConfigs(CH.main);
    if (SCAN_ISOLATION) ensureOneBotHttpConfigs(CH.scan);
}, 100);
oneBotConfigWatcher.unref();

// ===== 扫码会话租约（每通道一份，互不干扰）=====
// 隔离之后租约的作用从「让两类使用者互斥」变成「同一通道内多人排队」。
// 由于 system:* 全走 main、真人扫码全走 scan，两边各用各的锁，
// 后台重连与人工扫码从此不会互相拒绝。
//
// 空闲超时按“最后一次活动”计算：前端 2s 轮询会持续续租，
// 用户关掉页面即停止续租，约 IDLE 后自动释放，避免开着页面不扫堵死所有人。
// 【重要】2026-08-24 从 45s 降到 5s。单独降这个值会引入两个新 bug，
// 必须配套下面三个机制，不能只改 IDLE：
//   1) 取码要 stop+start QQ（最长 QR_TIMEOUT_MS），期间前端没有轮询在续租，
//      5s 空闲会让租约在自己取码途中被别人抢走 → 用 busy 保护长操作。
//   2) 手机长按二维码会切到 QQ，页面转后台后浏览器会冻结定时器，轮询停摆，
//      5s 会把正在扫的人踢掉 → 已发过码的会话给 SCAN_GRACE 宽限。
//   3) 关浏览器的常见情况不该靠超时硬等 → 前端卸载时调 /release 主动交回，瞬时生效。
const LEASE_IDLE_MS = Number(process.env.NAPCAT_LEASE_IDLE_MS) || 5000;
// 已经发出二维码的会话：从最后一次接触算起的扫码宽限（手机切到 QQ 时页面在后台）。
const LEASE_SCAN_GRACE_MS = Number(process.env.NAPCAT_LEASE_SCAN_GRACE_MS) || 10000;
// busy（取码/授权进行中）不受空闲超时约束，但必须有硬上限：
// 否则一次卡死的授权会把该实例永久锁死（旧版就是无限期，是个死锁风险）。
const LEASE_BUSY_MAX_MS = Number(process.env.NAPCAT_LEASE_BUSY_MAX_MS) || 120000;
// 授权耗时不可预测，给等待者一个固定重试提示，而不是报一个吓人的 120s。
const BUSY_RETRY_HINT_MS = 15000;
// 【防恶意占用】开着页面不扫的人靠 2s 轮询可以无限续租。
// 有人在排队时，单次持有最长到此为止，到点强制收回。没人等就不折腾。
const LEASE_MAX_HOLD_MS = Number(process.env.NAPCAT_LEASE_MAX_HOLD_MS) || 60000;
// 被强制收回后进入冷却，避免同一人立刻抢回来饿死排队者。
const LEASE_COOLDOWN_MS = Number(process.env.NAPCAT_LEASE_COOLDOWN_MS) || 30000;
// 等待者登记的有效期：超过这个时间没再来问，就不算还在排队。
const WAITER_TTL_MS = Number(process.env.NAPCAT_LEASE_WAITER_TTL_MS) || 30000;
const SYSTEM_OWNER_PREFIX = 'system:';

function isSystemOwner(owner) {
    return String(owner || '').startsWith(SYSTEM_OWNER_PREFIX);
}

/**
 * 一条通道一份租约。
 * 同时承担「无人扫码自动取消租约」：巡检定时器每秒调用 sweep()，
 * 到点立刻释放，不再等下一个请求来触发——僵尸租约最多存活 1 秒。
 */
function createLease(channelName) {
    // { owner, claimedAt, renewedAt, expiresAt, busy, busySince, qrIssued, scanUntil }
    let lease = null;
    const waiters = new Map(); // owner -> 最后一次被 409 拒绝的时间
    const cooldowns = new Map(); // owner -> 冷却到期时间戳

    function logLease(event, detail) {
        console.log(`[扫码租约][${channelName}] ${event} ${JSON.stringify(detail)}`);
    }

    // 后台无人值守任务（system:*）不算排队者：
    // 它不能成为把真人扫到一半的会话踢下去的理由。
    function noteWaiter(owner) {
        const who = String(owner || '').trim();
        if (who && !isSystemOwner(who)) waiters.set(who, Date.now());
    }

    function hasOtherWaiter(holder) {
        const now = Date.now();
        let found = false;
        for (const [who, at] of waiters) {
            if (now - at > WAITER_TTL_MS) { waiters.delete(who); continue; }
            if (who !== holder) found = true;
        }
        return found;
    }

    function cooldownRemainMs(owner) {
        const until = cooldowns.get(owner) || 0;
        const remain = until - Date.now();
        if (remain <= 0) { cooldowns.delete(owner); return 0; }
        return remain;
    }

    function alive() {
        if (!lease) return false;
        const now = Date.now();
        if (lease.busy) {
            // busy 不受空闲超时约束，但超过硬上限就当作卡死，自愈释放。
            if (now - lease.busySince > LEASE_BUSY_MAX_MS) {
                logLease('busy 超时自愈释放', { owner: lease.owner, heldMs: now - lease.busySince });
                lease = null;
                return false;
            }
            return true;
        }
        if (now < lease.expiresAt) return true;
        // 已发过码：给扫码宽限，避免手机切到 QQ 时被 5s 空闲踢掉。
        if (lease.scanUntil && now < lease.scanUntil) return true;
        return false;
    }

    function remainMs() {
        if (!alive()) return 0;
        if (lease.busy) return BUSY_RETRY_HINT_MS;
        const until = Math.max(lease.expiresAt, lease.scanUntil || 0);
        return Math.max(0, until - Date.now());
    }

    function info(owner) {
        if (!alive()) return { held: false };
        const who = String(owner || '').trim();
        return {
            held: true,
            owner: lease.owner,
            busy: !!lease.busy,
            remainMs: remainMs(),
            mine: !!who && lease.owner === who,
        };
    }

    function release(reason) {
        if (!lease) return;
        logLease('释放', { owner: lease.owner, reason });
        lease = null;
    }

    function releaseIfOwner(owner, reason) {
        const who = String(owner || '').trim();
        if (lease && who && lease.owner === who) release(reason);
    }

    function markBusy(owner, busy) {
        const who = String(owner || '').trim();
        if (lease && who && lease.owner === who) {
            lease.busy = !!busy;
            lease.busySince = busy ? Date.now() : 0;
            if (!busy) lease.expiresAt = Date.now() + LEASE_IDLE_MS;
        }
    }

    // 标记“本轮租约已经发出过二维码”：
    // 一是后续请求不再强制换码，二是开启扫码宽限。
    function markQrIssued(owner) {
        const who = String(owner || '').trim();
        if (lease && who && lease.owner === who) {
            lease.qrIssued = true;
            lease.scanUntil = Date.now() + LEASE_SCAN_GRACE_MS;
        }
    }

    // 持有超时：有人排队时强制收回并让其冷却，避免开着页面把实例焊死。
    // 授权进行中（busy）绝不打断：那会把人家成功一半的授权弄坏。
    function enforceMaxHold(requester) {
        if (!lease || lease.busy) return;
        const heldMs = Date.now() - lease.claimedAt;
        if (heldMs < LEASE_MAX_HOLD_MS) return;
        const rival = requester && requester !== lease.owner && !isSystemOwner(requester);
        if (!rival && !hasOtherWaiter(lease.owner)) return;
        cooldowns.set(lease.owner, Date.now() + LEASE_COOLDOWN_MS);
        logLease('持有超时强制收回', { owner: lease.owner, heldMs, cooldownMs: LEASE_COOLDOWN_MS });
        release('max-hold');
    }

    function conflict(owner) {
        // 任何被拒绝的人都算排队者：max-hold 强制收回要靠这个信号，
        // 否则开着页面不扫的人可以靠 2s 轮询无限续租，把实例焊死。
        noteWaiter(owner);
        const remain = remainMs();
        const seconds = Math.max(1, Math.ceil(remain / 1000));
        logLease('拒绝', { requester: owner, holder: lease && lease.owner, remainSec: seconds });
        return {
            // error 里的秒数是响应那一刻的快照，只给日志/旧版前端兼容用。
            // 新版前端用 busyReason + retryAfterMs 自己渲染实时倒计时，
            // 否则页面上会永远卡着一个不动的秒数。
            error: `另一位用户正在扫码授权 QQ，请约 ${seconds} 秒后重试（同一时刻只能有一人扫码）`,
            busyReason: '另一位用户正在扫码授权 QQ',
            busyNote: '同一时刻只能有一人扫码',
            retryAfterMs: remain,
            busy: true,
        };
    }

    /**
     * 申请或续租。成功返回 null，冲突返回可直接下发的 409 载荷。
     * - 同一 owner 重复请求视为续租
     * - 租约空闲超时后视为空闲，可被他人抢占
     * - renewOnly=true 用于只读轮询：owner 匹配则续租，空闲则不占用
     */
    function claim(owner, { renewOnly = false } = {}) {
        const who = String(owner || '').trim();
        if (!who) return { error: '缺少扫码会话归属标识', busy: false };

        enforceMaxHold(who);

        if (alive() && lease.owner !== who) return conflict(who);
        if (!alive()) {
            if (renewOnly) return null;
            // 刚被强制收回的人在冷却期内不能抢回来，但只在确实有人排队时才拦：
            // 没人等还拦着不让用，那是白白浪费实例。
            const cd = cooldownRemainMs(who);
            if (cd > 0 && hasOtherWaiter(who)) {
                const sec = Math.max(1, Math.ceil(cd / 1000));
                logLease('冷却中拒绝', { requester: who, remainSec: sec });
                return {
                    error: `你刚占用过扫码通道，请约 ${sec} 秒后再试（正在给排队的用户让位）`,
                    busyReason: '你刚占用过扫码通道',
                    busyNote: '正在给排队的用户让位',
                    retryAfterMs: cd,
                    busy: true,
                };
            }
            if (lease) release('idle-timeout');
            lease = {
                owner: who,
                claimedAt: Date.now(),
                renewedAt: Date.now(),
                expiresAt: Date.now() + LEASE_IDLE_MS,
                busy: false,
                busySince: 0,
                qrIssued: false,
                scanUntil: 0,
            };
            waiters.delete(who);
            logLease('占用', { owner: who, idleMs: LEASE_IDLE_MS });
            return null;
        }
        lease.renewedAt = Date.now();
        if (!lease.busy) {
            lease.expiresAt = Date.now() + LEASE_IDLE_MS;
            // 持续接触的扫码会话同步往后顶宽限，否则宽限会从发码那一刻就开始倒数。
            if (lease.qrIssued) lease.scanUntil = Date.now() + LEASE_SCAN_GRACE_MS;
        }
        return null;
    }

    // 每秒巡检：无人扫码（无续租）时立刻取消租约，不等下一个请求来发现。
    function sweep() {
        if (lease && !alive()) release('idle-sweep');
        const now = Date.now();
        for (const [who, at] of waiters) {
            if (now - at > WAITER_TTL_MS) waiters.delete(who);
        }
    }

    function forgetWaiter(owner) {
        waiters.delete(String(owner || '').trim());
    }

    /**
     * 本轮租约是否已发过码。
     * false = 新会话（换人，或同一人重开弹窗）→ 必须强制换一张新码，
     * 绝不能把上一轮的旧码/残留登录态交给新来的人。
     * true  = 同一轮续租 → 复用当前登录态，绝不重启（会杀掉用户正在扫的码）。
     */
    function isFresh(owner) {
        const who = String(owner || '').trim();
        if (!lease || !alive() || lease.owner !== who) return true;
        return !lease.qrIssued;
    }

    return { claim, release, releaseIfOwner, markBusy, markQrIssued, info, sweep, forgetWaiter, alive, isFresh };
}

const LEASES = {
    main: createLease('main'),
    scan: SCAN_ISOLATION ? createLease('scan') : createLease('main'),
};

/**
 * 按 owner 选通道。
 *   system:* → main（后台重连/刷新 Code，走常驻在线的主实例）
 *   其他（token:* 等真人会话）→ scan（独立实例，不打扰已在线账号）
 */
function channelFor(owner) {
    const who = String(owner || '').trim();
    if (isSystemOwner(who)) return CH.main;
    if (scanChannelReady()) return CH.scan;
    return CH.main;
}

function leaseFor(ch) {
    return ch.name === 'scan' && SCAN_ISOLATION ? LEASES.scan : LEASES.main;
}

// ===== 扫码实例空闲回收 =====
// 真人扫完（或放弃）后，租约释放即开始计时，到点停掉扫码实例的 QQ 进程，
// 把 ~300MB 还给系统。主实例不受影响，继续在线。
let scanIdleSince = Date.now();
let scanReclaiming = false;

function markScanActive() {
    scanIdleSince = Date.now();
}

async function reclaimScanInstanceIfIdle() {
    if (!SCAN_ISOLATION) return;
    if (scanReclaiming) return;
    if (LEASES.scan.alive()) { scanIdleSince = Date.now(); return; }
    if (Date.now() - scanIdleSince < SCAN_RECLAIM_IDLE_MS) return;
    scanReclaiming = true;
    try {
        const active = await CH.scan.auth.isTemporaryNapCatServiceActive();
        if (!active) return;
        console.log(`[扫码通道] 空闲超过 ${Math.round(SCAN_RECLAIM_IDLE_MS / 1000)}s，回收扫码实例的 QQ 进程`);
        await CH.scan.auth.stopTemporaryNapCat().catch(() => {});
    } finally {
        scanReclaiming = false;
        scanIdleSince = Date.now();
    }
}

// ===== 主实例掉线自愈（无人值守的关键一环）=====
// 容器重启后，entrypoint 的 keep_qq_alive 只会把 QQ 进程拉起来，不会触发快速登录，
// 于是 QQ 停在二维码界面；而农场任务只在 Code 快过期时才来刷新，
// 中间这段就是「NapCat 看起来活着、实际谁都没登录」，无人值守刷新形同虚设
// （实测重启后 5 分钟都没人来救）。这里让 bridge 自己盯住并恢复。
const MAIN_AUTO_RELOGIN_MS = Number(process.env.NAPCAT_MAIN_AUTO_RELOGIN_MS) || 120000;
// 连续自动恢复失败达到这个次数后，暂停自动恢复并等人工扫码，
// 避免「快速登录资料已失效」时无限 spawn QQ 进程把内存吃爆。
const MAIN_RELOGIN_MAX_FAILS = Number(process.env.NAPCAT_MAIN_RELOGIN_MAX_FAILS) || 2;
// 暂停时长：期间不再尝试自动恢复，也不拉起任何 QQ 进程。
const MAIN_RELOGIN_PAUSE_MS = Number(process.env.NAPCAT_MAIN_RELOGIN_PAUSE_MS) || 30 * 60 * 1000;
let mainReloginAt = Date.now();
let mainRelogining = false;
let mainReloginFails = 0;
let mainReloginPausedUntil = 0;
// 有人扫码登录成功后调用，清零失败计数、解除暂停。
function resetMainRelogin() {
    mainReloginFails = 0;
    mainReloginPausedUntil = 0;
}

// 选最近用过的那个账号：主实例是单账号的单例，优先保最有可能是当前在跑的那个。
function pickLatestProfileUin() {
    const root = path.join(CH.main.workdir, 'quick-login-profiles');
    try {
        const entries = fs.readdirSync(root)
            .filter(name => /^\d{5,20}$/.test(name))
            .map((name) => {
                let mtime = 0;
                try { mtime = fs.statSync(path.join(root, name)).mtimeMs || 0; } catch { /* 读不到就排最后 */ }
                return { uin: name, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
        return entries.length ? entries[0].uin : '';
    } catch {
        return '';
    }
}

async function ensureMainSessionOnline() {
    if (mainRelogining) return;
    // 有人正在授权/刷新 Code 就不插手
    if (LEASES.main.alive()) return;
    const now = Date.now();
    // 暂停期：快速登录资料已失效，自动恢复注定失败，别再 spawn QQ 浪费内存。
    if (now < mainReloginPausedUntil) return;
    if (now - mainReloginAt < MAIN_AUTO_RELOGIN_MS) return;
    mainReloginAt = now;
    // 占住主通道：自动登录要 stop→start QQ（约 60~90s），
    // 期间农场任务撞进来只会拿到「未登录」的错，不如让它稍后重试。
    const conflict = LEASES.main.claim('system:autologin');
    if (conflict) return;
    mainRelogining = true;
    LEASES.main.markBusy('system:autologin', true);
    try {
        if (!await CH.main.auth.isTemporaryNapCatServiceActive()) return; // 进程还没起来，entrypoint 会拉
        let profile = null;
        try { profile = await CH.main.auth.getNapCatLoginProfile(); } catch { /* 未登录 */ }
        if (profile && profile.uin) { mainReloginFails = 0; return; } // 已在线，无需处理
        const uin = pickLatestProfileUin();
        if (!uin) return;
        console.log(`[主实例] 会话在线但未登录，用快速登录资料自动恢复 QQ ${uin}`);
        try {
            await CH.main.auth.ensureTemporaryNapCatForUin(uin);
            const after = await CH.main.auth.getNapCatLoginProfile().catch(() => null);
            if (after && after.uin) {
                console.log(`[主实例] 已恢复登录：${after.nickname || ''}(${after.uin})`);
                mainReloginFails = 0;
            } else {
                throw new Error('自动恢复未成功');
            }
        } catch (error) {
            // 失败（多为快速登录资料已失效）：先把这次 spawn 出来、卡在二维码的
            // QQ 进程回收掉，否则每轮都留下一个孤儿，内存迟早被吃爆。
            try { await CH.main.auth.stopTemporaryNapCat(); } catch { /* 忽略 */ }
            mainReloginFails += 1;
            if (mainReloginFails >= MAIN_RELOGIN_MAX_FAILS) {
                mainReloginPausedUntil = Date.now() + MAIN_RELOGIN_PAUSE_MS;
                console.log(`[主实例] 连续 ${mainReloginFails} 次自动恢复失败（快速登录资料可能已失效），` +
                    `暂停自动恢复 ${Math.round(MAIN_RELOGIN_PAUSE_MS / 60000)} 分钟，请重新扫码登录 QQ ${uin}`);
            } else {
                console.log(`[主实例] 自动恢复登录失败(${mainReloginFails}/${MAIN_RELOGIN_MAX_FAILS}): ${error.message}`);
            }
        }
    } catch (error) {
        console.log(`[主实例] 自动恢复登录失败: ${error.message}`);
    } finally {
        mainRelogining = false;
        LEASES.main.markBusy('system:autologin', false);
        LEASES.main.releaseIfOwner('system:autologin', 'autologin-done');
    }
}

let sweepTick = 0;
const sweeper = setInterval(() => {
    // 无人扫码时自动取消租约：每秒巡检，到点立即释放，
    // 不再等下一个请求来发现（僵尸租约最多存活 1 秒）。
    LEASES.main.sweep();
    if (SCAN_ISOLATION) {
        LEASES.scan.sweep();
        reclaimScanInstanceIfIdle();
    }
    sweepTick += 1;
    if (sweepTick % 10 === 0) ensureScanDisplay();
    if (sweepTick % 30 === 0) ensureMainSessionOnline();
}, 1000);
sweeper.unref();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 读当前二维码文件状态（无副作用） */
function statQr(ch) {
    try {
        const stat = fs.statSync(ch.qrPath);
        if (!stat.size) return null;
        return { updatedAt: stat.mtimeMs, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
    } catch {
        return null;
    }
}

/** 读日志尾部（不整文件加载，日志有几 MB） */
function readLogTail(ch, bytes) {
    let fd;
    try {
        fd = fs.openSync(ch.logPath, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(bytes, size);
        if (!length) return '';
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, size - length);
        return buf.toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关闭 */ } }
    }
}

// 日志时间戳没有年份（`08-25 09:59:43`），按当年补齐；
// 跨年时会算出一个「未来」的日期，回退一年。
function parseLogStamp(mm, dd, HH, MM, SS) {
    const now = new Date();
    const build = year => new Date(year, Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS)).getTime();
    let at = build(now.getFullYear());
    if (at - now.getTime() > 86400000) at = build(now.getFullYear() - 1);
    return at;
}

const QR_SAVED_RE = /(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})[^\n]*?二维码已保存到/g;
const QR_URL_RE = /二维码解码URL[:：]\s*(\S+)/g;

/**
 * 取当前 qrcode.png 对应的解码 URL；拿不准就返回空（前端退回原始 PNG）。
 * 日志顺序固定为：`二维码解码URL: ...` → ASCII art → `二维码已保存到 ...qrcode.png`，
 * 所以「最后一个保存标记」之前的「最后一条 URL」就是当前这张图的内容。
 */
function readQrUrl(ch, pngUpdatedAt) {
    const tail = readLogTail(ch, QR_LOG_TAIL_BYTES);
    if (!tail) return '';

    let saved = null;
    QR_SAVED_RE.lastIndex = 0;
    for (let m = QR_SAVED_RE.exec(tail); m; m = QR_SAVED_RE.exec(tail)) {
        saved = { index: m.index, at: parseLogStamp(m[1], m[2], m[3], m[4], m[5]) };
    }
    if (!saved) return '';
    // 时间戳对不上 = 这条日志不是当前这张图，宁可不发。
    if (Math.abs(saved.at - pngUpdatedAt) > QR_URL_MATCH_TOLERANCE_MS) return '';

    let url = '';
    QR_URL_RE.lastIndex = 0;
    for (let m = QR_URL_RE.exec(tail); m; m = QR_URL_RE.exec(tail)) {
        if (m.index > saved.index) break;
        url = m[1];
    }
    // 去掉可能夹带的 ANSI/控制字符，并做一次协议白名单校验。
    url = url.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!/^https?:\/\/\S+$/.test(url)) return '';
    return url;
}

function readQr(ch, info) {
    // qrUrl 只在能与当前 PNG 对上时才带出；拿不到就只回 PNG，前端自动降级。
    const qrUrl = readQrUrl(ch, info.updatedAt);
    return {
        qrcode: `data:image/png;base64,${fs.readFileSync(ch.qrPath).toString('base64')}`,
        updatedAt: info.updatedAt,
        ageMs: info.ageMs,
        ...(qrUrl ? { qrUrl } : {}),
    };
}

function json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) {
                reject(new Error('request too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('invalid JSON')); }
        });
        req.on('error', reject);
    });
}

/**
 * 等一张 mtime 不早于 notBefore 的二维码。
 * notBefore 仅在“我们刚主动重启过会话”时传，用于避开重启前遗留的文件；
 * 会话本来就活着时 notBefore=0，直接用当前文件（NapCat 自己轮换，不需我们管）。
 */
async function waitForQr(ch, timeoutMs = QR_TIMEOUT_MS, notBefore = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const info = statQr(ch);
        if (info && info.updatedAt >= notBefore) return readQr(ch, info);
        await sleep(250);
    }
    throw new Error(`QQ 扫码二维码生成超时（${ch.qrPath}）`);
}

/**
 * 拿一张可用二维码。
 * - 会话已在跑：直接读当前文件，绝不重启（重启会杀掉用户正在扫的码）
 * - 会话不在（或 force=用户显式点刷新）：stop → 删旧码 → start → 等新码
 */
async function ensureQr(ch, { force = false } = {}) {
    const active = await ch.auth.isTemporaryNapCatServiceActive();
    if (active && !force) {
        const info = statQr(ch);
        if (info) return readQr(ch, info);
        // 会话刚拉起、码还没写出来：等一下就好，不要重启
        return waitForQr(ch);
    }
    const startedAt = Date.now();
    await ch.auth.stopTemporaryNapCat().catch(() => {});
    try { fs.unlinkSync(ch.qrPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await ch.auth.startTemporaryNapCat();
    return waitForQr(ch, QR_TIMEOUT_MS, startedAt);
}

/**
 * 在指定实例上取一张二维码。
 * 返回 { ok:true, data } 或 { ok:false, error }，失败时已自行释放租约。
 */
async function tryFetchQr(ch, lease, owner, force) {
    lease.markBusy(owner, true);
    try {
        if (!force) {
            // 续租且本轮已发过码：用户可能刚扫上，复用登录态直接进授权。
            try {
                const profile = await ch.auth.getNapCatLoginProfile();
                if (profile.uin) return { ok: true, data: { loggedIn: true, profile } };
            } catch { /* 未登录，继续出码 */ }
        }
        const qr = await enqueue(ch, () => ensureQr(ch, { force }));
        return { ok: true, data: { loggedIn: false, ...qr } };
    } catch (error) {
        // 取码失败就别继续占着实例，让下一个人马上能用。
        lease.releaseIfOwner(owner, 'qrcode-failed');
        return { ok: false, error: error.message };
    } finally {
        lease.markBusy(owner, false);
        lease.markQrIssued(owner);
    }
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true });
    }
    // 无副作用探测：供前端 2s 轮询“扫没扫”。绝不在这里重启 QQ，
    // 否则轮询会把用户正在扫的会话反复打死。
    if (req.method === 'GET' && url.pathname === '/status') {
        const owner = String(url.searchParams.get('owner') || '').trim();
        const ch = channelFor(owner);
        const lease = leaseFor(ch);
        if (ch.name === 'scan') markScanActive();
        const holder = lease.alive() ? lease.info(owner).owner : '';
        const isOwner = !!owner && holder === owner;
        if (isOwner) lease.claim(owner, { renewOnly: true });
        let loggedIn = false;
        let profile = null;
        try {
            profile = await ch.auth.getNapCatLoginProfile();
            loggedIn = !!profile.uin;
        } catch { /* 会话还没起来 */ }
        const info = statQr(ch);
        // 会话归别人时不外泄对方的登录态与 QQ 资料。
        const visible = !holder || isOwner;
        return json(res, 200, {
            ok: true,
            data: {
                loggedIn: visible ? loggedIn : false,
                profile: visible && loggedIn ? profile : undefined,
                hasQr: visible ? !!info : false,
                ageMs: visible && info ? info.ageMs : null,
                updatedAt: visible && info ? info.updatedAt : null,
                sessionActive: await ch.auth.isTemporaryNapCatServiceActive(),
                // 前端据此提示“有人正在扫码”，而不是把别人的二维码/登录态当成自己的。
                // 字段名保持不变，前端无需改动；内容为当前通道的租约。
                scanLease: lease.info(owner),
                channel: ch.name,
            },
        });
    }
    if (req.method === 'GET' && url.pathname === '/image') {
        // 无副作用：只读当前 qrcode.png。NapCat 自己每 ~122s 重写该文件，
        // 前端靠 updatedAt 变化拉这个接口跟随换图，全程不碰进程。
        // 但必须校验归属：否则会把持有者正在扫的那张码发给别人，
        // 导致对方扫完登进去的是持有者的 QQ。
        const owner = String(url.searchParams.get('owner') || '').trim();
        const ch = channelFor(owner);
        const lease = leaseFor(ch);
        if (ch.name === 'scan') markScanActive();
        if (lease.alive() && lease.info(owner).owner !== owner) return json(res, 409, { ok: false, ...busyPayload(lease, owner) });
        if (owner) lease.claim(owner, { renewOnly: true });
        const info = statQr(ch);
        if (!info) return json(res, 404, { ok: false, error: '当前无二维码' });
        return json(res, 200, { ok: true, data: readQr(ch, info) });
    }
    if (req.method === 'GET' && url.pathname === '/qrcode') {
        const owner = String(url.searchParams.get('owner') || '').trim();
        let ch = channelFor(owner);
        let lease = leaseFor(ch);
        if (ch.name === 'scan') { markScanActive(); ensureScanDisplay(); }
        const conflict = lease.claim(owner);
        if (conflict) return json(res, 409, { ok: false, ...conflict });
        // 本轮租约还没发过码 = 新会话（换人，或同一人重开弹窗）。
        // 这种情况必须强制换一张新码，绝不能把上一轮的旧码/残留登录态交出去：
        //   - 旧码可能正是上一个人在扫的那张，对方扫完登进去的是别人的 QQ；
        //   - 残留登录态会让新来的人一点「添加」就把别人的 QQ 挂到自己名下。
        // force 走 stop → 删码 → start，顺带把上一轮的残留会话清干净。
        const result = await tryFetchQr(ch, lease, owner, lease.isFresh(owner));
        if (result.ok) return json(res, 200, { ok: true, data: result.data });
        // 【降级兜底】扫码实例拉不起来时（显示器异常、内存不够、冷启动失败……），
        // 退回主实例再试一次。隔离是优化，不是前提——
        // 绝不能因为「独立实例」这个新特性把扫码本身弄坏，
        // 宁可退回共享模式让用户排会儿队，也比拿不到码强。
        if (ch.name === 'scan') {
            console.log(`[扫码通道] 独立实例取码失败（${result.error}），降级到主实例重试`);
            ch = CH.main;
            lease = LEASES.main;
            const retryConflict = lease.claim(owner);
            if (retryConflict) return json(res, 409, { ok: false, ...retryConflict });
            const retried = await tryFetchQr(ch, lease, owner, lease.isFresh(owner));
            if (retried.ok) return json(res, 200, { ok: true, data: retried.data });
            return json(res, 502, { ok: false, error: retried.error });
        }
        return json(res, 502, { ok: false, error: result.error });
    }
    if (req.method === 'POST' && url.pathname === '/refresh') {
        // force=true 会 stop+start 该实例的会话，必须是持有者才能做，
        // 否则任何人点一下刷新就能把别人正在扫的码打死。
        const owner = String(url.searchParams.get('owner') || '').trim();
        const ch = channelFor(owner);
        const lease = leaseFor(ch);
        if (ch.name === 'scan') { markScanActive(); ensureScanDisplay(); }
        const conflict = lease.claim(owner);
        if (conflict) return json(res, 409, { ok: false, ...conflict });
        const result = await tryFetchQr(ch, lease, owner, true);
        if (result.ok) return json(res, 200, { ok: true, data: result.data });
        if (ch.name === 'scan') {
            console.log(`[扫码通道] 独立实例刷新失败（${result.error}），降级到主实例重试`);
            const mainLease = LEASES.main;
            const retryConflict = mainLease.claim(owner);
            if (retryConflict) return json(res, 409, { ok: false, ...retryConflict });
            const retried = await tryFetchQr(CH.main, mainLease, owner, true);
            if (retried.ok) return json(res, 200, { ok: true, data: retried.data });
            return json(res, 502, { ok: false, error: retried.error });
        }
        return json(res, 502, { ok: false, error: result.error });
    }
    // 关页面/切走时主动交回租约：不靠空闲超时硬等，下一个人立刻能扫。
    // 配合每秒巡检，即使前端没来得及发这个请求（崩溃/断网），
    // 租约也会在 1 秒内被自动取消。
    if (req.method === 'POST' && url.pathname === '/release') {
        const body = await readBody(req).catch(() => ({}));
        const owner = String((body && body.owner) || url.searchParams.get('owner') || '').trim();
        if (!owner) return json(res, 200, { ok: true, data: { released: false, reason: 'no-owner' } });
        const ch = channelFor(owner);
        const lease = leaseFor(ch);
        const snapshot = lease.info(owner);
        if (lease.alive() && snapshot.owner === owner && snapshot.busy) {
            return json(res, 200, { ok: true, data: { released: false, reason: 'busy' } });
        }
        const held = lease.alive() && snapshot.owner === owner;
        lease.releaseIfOwner(owner, 'client-release');
        lease.forgetWaiter(owner);
        return json(res, 200, { ok: true, data: { released: held } });
    }
    // 页面从后台切回时的“软重新占用”：不换码、不重启会话。
    // 必要性：iOS Safari 切到 QQ app 扫码时也可能触发 pagehide，
    // 那会把正在扫码的自己的租约交回去。回前台后靠这个接口拿回来，
    // 屏幕上那张码继续有效；若已被别人抢走则返回 409，前端改成排队提示。
    if (req.method === 'POST' && url.pathname === '/reclaim') {
        const body = await readBody(req).catch(() => ({}));
        const owner = String((body && body.owner) || url.searchParams.get('owner') || '').trim();
        const ch = channelFor(owner);
        const lease = leaseFor(ch);
        if (ch.name === 'scan') markScanActive();
        const conflict = lease.claim(owner);
        if (conflict) return json(res, 409, { ok: false, ...conflict });
        // 屏幕上已有一张活码，标记 qrIssued 避免后续请求把它强制换掉。
        const info = statQr(ch);
        if (info) lease.markQrIssued(owner);
        return json(res, 200, { ok: true, data: { reclaimed: true, hasQr: !!info } });
    }
    if (req.method === 'POST' && url.pathname === '/authorize') {
        let owner = '';
        let ch = CH.main;
        let lease = LEASES.main;
        try {
            const body = await readBody(req);
            const quickUin = String(body.uin || '').trim();
            owner = String(body.owner || '').trim();
            ch = channelFor(owner);
            lease = leaseFor(ch);
            if (ch.name === 'scan') markScanActive();
            // 授权内部会 stopTemporaryNapCat({cacheUin})，会把该实例的会话关掉。
            // 所以必须持有租约才能授权，否则 A 的成功会顺带杀掉 B 正在扫的会话。
            const conflict = lease.claim(owner);
            if (conflict) return json(res, 409, { ok: false, ...conflict });
            lease.markBusy(owner, true);
            const data = await enqueue(ch, async () => {
                let cacheUin = '';
                try {
                    // 先看当前活会话。用户刚扫码登录进来的往往就是目标 QQ，此时必须直接复用这个会话。
                    // 原先无条件走 ensureTemporaryNapCatForUin()，它会先把刚扫上的会话 stop 掉，
                    // 再去 quick-login-profiles 找一份「从未被保存过」的资料 → 死循环报
                    // 「该 QQ 尚未保存快速登录资料，请先扫码授权一次」。
                    // 而那份资料只在本函数成功后的 stopTemporaryNapCat({cacheUin}) 里才会写入，
                    // 于是已存在的 QQ 账号永远无法重新授权（新账号 quickUin 为空反而能过）。
                    let profile = null;
                    try { profile = await ch.auth.getNapCatLoginProfile(); } catch { /* 未登录 */ }
                    const liveUin = profile && profile.uin ? profile.uin : '';

                    if (liveUin && quickUin && liveUin !== quickUin) {
                        throw new Error(`当前扫码登录的是 QQ ${liveUin}，与目标账号 ${quickUin} 不一致`);
                    }
                    if (!liveUin) {
                        // 无活会话：走保存过的快速登录资料（无人值守刷新 Code 用）
                        if (!quickUin) throw new Error('QQ 尚未登录，请先扫码');
                        await ch.auth.ensureTemporaryNapCatForUin(quickUin);
                        profile = await ch.auth.getNapCatLoginProfile();
                    }

                    cacheUin = profile.uin || quickUin;
                    if (quickUin && profile.uin !== quickUin) throw new Error('QQ 快速登录账号不匹配');
                    const authorization = await ch.auth.requestNapCatFarmAuthorization();
                    // 扫码实例上授权的账号，把资料转存给主实例，
                    // 这样以后的掉线重连/刷新 Code 走常驻的主实例，不用再扫码。
                    if (ch.name === 'scan' && profile.uin) {
                        try { promoteScanProfileToMain(profile.uin); } catch { /* 不影响本次授权 */ }
                        resetMainRelogin(); // 重新扫码成功，解除自动恢复的暂停
                    }
                    return { authorization, profile };
                } finally {
                    if (cacheUin) await ch.auth.stopTemporaryNapCat({ cacheUin }).catch(() => {});
                }
            });
            return json(res, 200, { ok: true, data });
        } catch (error) {
            return json(res, 502, { ok: false, error: error.message, stage: ch.auth.getNapCatRuntimeState().lastErrorStage });
        } finally {
            // 授权是终点：无论成败都立即释放，下一个人马上能扫。
            lease.markBusy(owner, false);
            lease.releaseIfOwner(owner, 'authorize-done');
            // 扫码实例用完就开始计时回收，别让第二个 Electron 白白占着内存。
            if (ch.name === 'scan') scanIdleSince = Date.now();
        }
    }
    return json(res, 404, { ok: false, error: 'not found' });
}

// ---- 租约辅助 ----
// /image 是无副作用读图，但撞上别人的租约时仍要返回 409 冲突载荷。
// 这里复用 claim() 的冲突分支：它会登记排队者（max-hold 强制收回依赖这个信号），
// 语义与 busyConflict() 一致，只是不再暴露模块级的 lease 变量。
function busyPayload(lease, owner) {
    const conflict = lease.claim(owner);
    return conflict || { error: '扫码通道忙', busy: true, retryAfterMs: 0 };
}

try { fs.unlinkSync(SOCKET_PATH); } catch (error) { if (error.code !== 'ENOENT') throw error; }
fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
const server = http.createServer((req, res) => Promise.resolve(handle(req, res)).catch(error => json(res, 500, { ok: false, error: error.message })));
server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o666);
    console.log(`NapCat bridge listening on ${SOCKET_PATH}`);
    console.log(`[通道] main=${CH.main.workdir} onebot=${CH.main.onebotPort} display=${CH.main.display}`);
    console.log(SCAN_ISOLATION
        ? `[通道] scan=${CH.scan.workdir} onebot=${CH.scan.onebotPort} webui=${SCAN_WEBUI_PORT} display=${CH.scan.display}（真人扫码独立实例）`
        : '[通道] scan=已关闭隔离，所有人共用主实例');
});
function shutdown() { server.close(() => { try { fs.unlinkSync(SOCKET_PATH); } catch { /* 已删除 */ } process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
