"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require('node:crypto');
const store = require('../../models/store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');
function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp)
        return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp)
        return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first)
            return first;
    }
    const address = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}
const issueToken = () => crypto.randomBytes(24).toString('hex');
function createAuthRequired(ctx) {
    return (req, res, next) => {
        const token = String(req.headers['x-admin-token'] || '');
        if (!token || !ctx.tokens.has(token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        next();
    };
}
function getAccountList(ctx) {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts))
                return data.accounts;
        }
    }
    catch {
        // Fall back to persistent storage.
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}
function getAccountIds(ctx) {
    return getAccountList(ctx).map((account) => String(account.id || '')).filter(Boolean);
}
const isSoftRuntimeError = (err) => {
    const message = String(err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};
function handleApiError(res, err) {
    if (isSoftRuntimeError(err)) {
        res.json({ ok: false, error: err.message });
        return;
    }
    res.status(500).json({ ok: false, error: err.message });
}
function resolveAccId(ctx, rawRef) {
    const input = normalizeAccountRef(rawRef);
    if (!input)
        return '';
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider)
            return resolvedByProvider;
    }
    return resolveAccountId(getAccountList(ctx), input) || input;
}
function getAccId(ctx, req) {
    return resolveAccId(ctx, req.headers['x-account-id']);
}
function buildKnownFriendGidSettings(accountId) {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
        knownFriendGidsManualLock: store.getKnownFriendGidsManualLock
            ? !!store.getKnownFriendGidsManualLock(accountId)
            : false,
    };
}
module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
//# sourceMappingURL=middleware.js.map