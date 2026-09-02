"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const security = require('./auth-security');
const ADMIN_FILE = getDataFile('admin.json');
let admin = null;
function normalizeAdmin(raw) {
    if (!raw || typeof raw !== 'object' || !String(raw.password || '').trim())
        return null;
    return {
        username: String(raw.username || 'admin').trim() || 'admin',
        password: String(raw.password),
        createdAt: Number(raw.createdAt) || Date.now(),
        mustChangePassword: raw.mustChangePassword === true || undefined,
    };
}
function saveAdmin() {
    ensureDataDir();
    if (!admin)
        return;
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ admin }, null, 2), 'utf8');
}
function loadAdmin() {
    ensureDataDir();
    if (admin)
        return admin;
    try {
        if (fs.existsSync(ADMIN_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
            admin = normalizeAdmin(data?.admin || data);
        }
    }
    catch {
        admin = null;
    }
    if (!admin) {
        admin = {
            username: 'admin',
            password: security.hashPassword('admin'),
            createdAt: Date.now(),
            mustChangePassword: true,
        };
        saveAdmin();
        console.log('[管理员] 已创建默认账号 admin，默认密码 admin');
    }
    return admin;
}
function getAdminInfo() {
    const current = loadAdmin();
    return { username: current.username, role: 'admin', mustChangePassword: current.mustChangePassword === true };
}
function validateAdmin(username, password, ip = 'unknown') {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed)
        return { error: 'rate_limit', ...rateLimit };
    const lockout = security.checkAdminLockout();
    if (lockout.locked)
        return { error: 'locked', ...lockout };
    const current = loadAdmin();
    if (username !== current.username || !security.verifyPassword(password, current.password)) {
        const attempt = security.recordFailedAttempt();
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }
    security.clearFailedAttempts();
    if (security.needsRehash(current.password)) {
        current.password = security.hashPassword(password);
        saveAdmin();
    }
    return getAdminInfo();
}
function changePassword(oldPassword, newPassword) {
    const current = loadAdmin();
    if (!security.verifyPassword(oldPassword, current.password))
        return { ok: false, error: '当前密码错误' };
    const validation = security.validatePasswordStrength(newPassword);
    if (!validation.valid)
        return { ok: false, error: validation.errors.join('；') };
    current.password = security.hashPassword(newPassword);
    delete current.mustChangePassword;
    saveAdmin();
    return { ok: true, message: '密码修改成功' };
}
loadAdmin();
module.exports = { getAdminInfo, validateAdmin, changePassword };
//# sourceMappingURL=admin-store.js.map