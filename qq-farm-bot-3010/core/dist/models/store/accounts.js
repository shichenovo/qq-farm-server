"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('node:fs');
const { ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../../services/json-db');
const { ACCOUNTS_FILE } = require('./shared-state');
function loadAccounts() {
    ensureDataDir();
    const data = readJsonFile(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
    return normalizeAccountsData(data);
}
function saveAccounts(data) {
    ensureDataDir();
    writeJsonFileAtomic(ACCOUNTS_FILE, normalizeAccountsData(data));
}
function getAccounts() {
    return loadAccounts();
}
function normalizeAccountsData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m, a) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0)
        nextId = maxId + 1;
    if (accounts.length === 0)
        nextId = 1;
    if (nextId <= maxId)
        nextId = maxId + 1;
    return { accounts, nextId };
}
function normalizeAccount(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account = {
        id: String(source.id || ''),
        name: String(source.name || ''),
        code: String(source.code || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick)
        account.nick = nick;
    // QQ 扫码/NapCat 链路需要持久化的附加字段：openID 用于「刷新 Code 时校验
    // 会话仍是同一 QQ」，loginType 决定自动刷新走 NapCat OpenAuth 还是 YYB Go。
    const openID = String(source.openID || '').trim();
    if (openID)
        account.openID = openID;
    const openid = String(source.openid || '').trim();
    if (openid)
        account.openid = openid;
    const loginType = String(source.loginType || '').trim();
    if (loginType)
        account.loginType = loginType;
    const yybOpenid = String(source.yybOpenid || '').trim();
    if (yybOpenid)
        account.yybOpenid = yybOpenid;
    const wxid = String(source.wxid || '').trim();
    if (wxid)
        account.wxid = wxid;
    return account;
}
function addOrUpdateAccount(acc) {
    const { ensureAccountConfig, removeAccountConfig } = require('./account-config');
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    const source = acc || {};
    const cleanAccount = {};
    for (const key of ['id', 'name', 'code', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick', 'openID', 'openid', 'loginType', 'yybOpenid', 'wxid']) {
        if (source[key] !== undefined)
            cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    }
    else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            loginType: acc.loginType || '',
            yybOpenid: acc.yybOpenid || '',
            wxid: acc.wxid || '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    saveAccounts(data);
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    return data;
}
function deleteAccount(id) {
    const { removeAccountConfig } = require('./account-config');
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}
module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
};
//# sourceMappingURL=accounts.js.map