"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { readTextFile, writeJsonFileAtomic } = require('../../services/json-db');
const { DEFAULT_CLIENT_VERSION, DEFAULT_TIME_ZONE, normalizeTimeZone, resolveClientVersionUpdatedAt } = require('../../config/config');
const sharedState = require('./shared-state');
const { STORE_FILE, PUSHOO_CHANNELS, DEFAULT_OFFLINE_REMINDER, DEFAULT_WX_CONFIG, globalConfig, normalizeAccountConfig, cloneAccountConfig, DEFAULT_ACCOUNT_CONFIG, } = sharedState;
function normalizeWxConfig(input) {
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    return {
        enabled: src.enabled !== undefined ? !!src.enabled : DEFAULT_WX_CONFIG.enabled,
        apiBase: (src.apiBase !== undefined && src.apiBase !== null) ? String(src.apiBase).trim() : DEFAULT_WX_CONFIG.apiBase,
        apiKey: (src.apiKey !== undefined && src.apiKey !== null) ? String(src.apiKey).trim() : DEFAULT_WX_CONFIG.apiKey,
        appId: (src.appId !== undefined && src.appId !== null) ? String(src.appId).trim() : DEFAULT_WX_CONFIG.appId,
        autoAddAccount: src.autoAddAccount !== undefined ? !!src.autoAddAccount : DEFAULT_WX_CONFIG.autoAddAccount,
        userIsolation: src.userIsolation !== undefined ? !!src.userIsolation : DEFAULT_WX_CONFIG.userIsolation,
        autoReconnect: src.autoReconnect !== undefined ? !!src.autoReconnect : DEFAULT_WX_CONFIG.autoReconnect,
        reconnectDelayMin: Math.max(1, Math.min(1440, Number(src.reconnectDelayMin) || DEFAULT_WX_CONFIG.reconnectDelayMin)),
        reconnectMaxAttempts: Math.max(1, Math.min(100, Number(src.reconnectMaxAttempts) || DEFAULT_WX_CONFIG.reconnectMaxAttempts)),
    };
}
function normalizeOfflineReminder(input) {
    const src = (input && typeof input === 'object') ? input : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const secret = (src.secret !== undefined && src.secret !== null)
        ? String(src.secret).trim()
        : DEFAULT_OFFLINE_REMINDER.secret;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        endpoint,
        token,
        secret,
        title,
        msg,
        offlineDeleteSec,
    };
}
function sanitizeGlobalConfigBeforeSave() {
    sharedState.accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(sharedState.accountFallbackConfig);
    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid)
            continue;
        nextMap[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
    }
    globalConfig.accountConfigs = nextMap;
    if (globalConfig.globalWxConfig) {
        globalConfig.globalWxConfig = normalizeWxConfig(globalConfig.globalWxConfig);
    }
}
function saveGlobalConfig() {
    const { ensureDataDir } = require('../../config/runtime-paths');
    ensureDataDir();
    try {
        const oldJson = readTextFile(STORE_FILE, '');
        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);
        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    }
    catch (e) {
        console.error('保存配置失败:', e.message);
    }
}
function getUI() {
    return { ...globalConfig.ui };
}
function setUITheme(theme) {
    const t = String(theme || '').toLowerCase();
    const next = (t === 'light') ? 'light' : 'dark';
    // Import here to avoid circular - use direct globalConfig mutation
    if (globalConfig.ui) {
        globalConfig.ui.theme = next;
    }
    saveGlobalConfig();
    return getUI();
}
function getOfflineReminder() {
    return normalizeOfflineReminder(globalConfig.offlineReminder);
}
function setOfflineReminder(cfg) {
    const current = normalizeOfflineReminder(globalConfig.offlineReminder);
    globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getOfflineReminder();
}
function getSystemConfig() {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}
function setSystemConfig(config) {
    if (!config || typeof config !== 'object')
        return null;
    const DEFAULT_DEVICE_INFO = {
        os: 'Windows',
        clientVersion: DEFAULT_CLIENT_VERSION,
        sysSoftware: 'Windows',
        network: 'wifi',
        memory: '16384',
        deviceId: 'DESKTOP-PC<WPC>',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
    };
    const srcDevice = (config.deviceInfo && typeof config.deviceInfo === 'object') ? config.deviceInfo : {};
    const topVersion = String(config.clientVersion || '').trim();
    const deviceVersion = String(srcDevice.clientVersion || '').trim();
    const requestedVersion = deviceVersion || topVersion;
    const clientVersion = requestedVersion || DEFAULT_DEVICE_INFO.clientVersion;
    const currentVersion = String(globalConfig.systemConfig?.clientVersion || DEFAULT_DEVICE_INFO.clientVersion).trim();
    const currentUpdatedAt = Number(globalConfig.systemConfig?.clientVersionUpdatedAt);
    const clientVersionUpdatedAt = resolveClientVersionUpdatedAt(clientVersion, currentVersion, currentUpdatedAt, config.clientVersionUpdatedAt);
    const deviceInfo = {
        os: String(srcDevice.os || DEFAULT_DEVICE_INFO.os).trim(),
        clientVersion,
        sysSoftware: String(srcDevice.sysSoftware || DEFAULT_DEVICE_INFO.sysSoftware).trim(),
        network: String(srcDevice.network || DEFAULT_DEVICE_INFO.network).trim(),
        memory: String(srcDevice.memory || DEFAULT_DEVICE_INFO.memory).trim(),
        deviceId: String(srcDevice.deviceId || DEFAULT_DEVICE_INFO.deviceId).trim(),
        userAgent: String(srcDevice.userAgent || DEFAULT_DEVICE_INFO.userAgent).trim(),
    };
    globalConfig.systemConfig = {
        serverUrl: String(config.serverUrl || '').trim(),
        clientVersion: deviceInfo.clientVersion,
        clientVersionUpdatedAt,
        platform: String(config.platform || 'qq').trim(),
        os: deviceInfo.os,
        timeZone: normalizeTimeZone(config.timeZone || DEFAULT_TIME_ZONE),
        deviceInfo,
    };
    saveGlobalConfig();
    return { ...globalConfig.systemConfig };
}
function getGlobalWxConfig() {
    return normalizeWxConfig(globalConfig.globalWxConfig);
}
function setGlobalWxConfig(cfg) {
    const current = normalizeWxConfig(globalConfig.globalWxConfig);
    globalConfig.globalWxConfig = normalizeWxConfig({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getGlobalWxConfig();
}
// start.sh 单镜像部署时会自动生成 YYB API Token 并导出环境变量 YYB_API_KEY
// （与 YYB_API_TOKEN 同值）。这里把环境变量预填进 wx-config，让微信自动刷新
// Code 一开机就能用，不必等用户去设置页手动填一遍。
function ensureYybAutoConfig() {
    const current = normalizeWxConfig(globalConfig.globalWxConfig);
    const envKey = String(process.env.YYB_API_KEY || process.env.YYB_API_TOKEN || '').trim();
    const envBase = String(process.env.YYB_API_BASE || '').trim().replace(/\/+$/, '');
    const needsPatch = (envKey && current.apiKey !== envKey) || (envBase && current.apiBase !== envBase);
    if (!needsPatch)
        return current;
    const next = {
        ...current,
        apiKey: envKey || current.apiKey,
        apiBase: envBase || current.apiBase,
    };
    globalConfig.globalWxConfig = normalizeWxConfig(next);
    saveGlobalConfig();
    return getGlobalWxConfig();
}
// Initialize on load
const { loadGlobalConfig } = sharedState;
loadGlobalConfig();
// Apply offlineReminder normalization after load
globalConfig.offlineReminder = normalizeOfflineReminder(globalConfig.offlineReminder);
// Apply wx-config normalization after load (incl. env prefill)
globalConfig.globalWxConfig = normalizeWxConfig(globalConfig.globalWxConfig);
ensureYybAutoConfig();
if (sharedState.systemConfigMigrated) {
    saveGlobalConfig();
    sharedState.systemConfigMigrated = false;
}
module.exports = {
    saveGlobalConfig,
    getUI,
    setUITheme,
    getOfflineReminder,
    setOfflineReminder,
    getSystemConfig,
    setSystemConfig,
    getGlobalWxConfig,
    setGlobalWxConfig,
    ensureYybAutoConfig,
    normalizeWxConfig,
};
//# sourceMappingURL=global-config.js.map