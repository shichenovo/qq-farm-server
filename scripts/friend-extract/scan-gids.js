#!/usr/bin/env node
"use strict";

// 用扫码取到的 Code 直连游戏网关，拉取「扫码这个 QQ 自己」的游戏好友 GID。
// 复用农场 bot 已编译的 dist（network.js / proto.js / ACE WASM），零改动农场 bot 运行代码。
//
// 诊断增强：把 farm-bot 打到 stdout 的日志、WS 错误、断连原因都收集进返回结果，
// 定位「connect(code) 登录不上网关」的真实原因，并在检测到失败时提前退出（不再傻等满 timeout）。

const fs = require('fs');
const path = require('path');

const SCAN_CODE = (process.env.SCAN_CODE || '').trim();
const FARM_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';
const TIMEOUT_MS = Math.max(10000, parseInt(process.env.SCAN_GIDS_TIMEOUT || '35000', 10));
const RESULT_FILE = process.env.SCAN_RESULT_FILE || '';

// ---- 诊断收集：缓冲 stdout/stderr，并挂钩 farm-bot 的网络事件 ----
const diag = { logs: [], wsErrors: [], disconnect: null, startedAt: Date.now() };
function pushLog(s) {
  const str = String(s == null ? '' : s);
  diag.logs.push(str);
  if (diag.logs.length > 300) diag.logs.shift();
}
const _out = process.stdout.write.bind(process.stdout);
const _err = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, e, cb) => { pushLog(c); return _out(c, e, cb); };
process.stderr.write = (c, e, cb) => { pushLog(c); return _err(c, e, cb); };
function diagTail() {
  const tail = diag.logs.join('').replace(/\r?\n+/g, ' ⏎ ').replace(/\s+/g, ' ').trim().slice(-1000);
  return tail ? ' | 日志片段: ' + tail : '';
}
function detectFailure() {
  const j = diag.logs.join('');
  if (/账号验证失败|验证失败|code=\s*\d+/.test(j)) return '账号验证失败（授权码无效/已被使用/过期，网关拒绝登录）';
  if (/登录响应超时|登录.*超时/.test(j)) return '网关登录响应超时（20s 内未返回登录回包）';
  if (diag.disconnect && diag.disconnect.reason) return '连接已断开: ' + diag.disconnect.reason;
  if (diag.disconnect && diag.disconnect.source) return '连接已结束: ' + diag.disconnect.source;
  if (diag.wsErrors.length) return '网关连接错误: ' + JSON.stringify(diag.wsErrors[diag.wsErrors.length - 1]);
  const ws = (typeof getWsErrorState === 'function') ? getWsErrorState() : null;
  if (ws && ws.code) return '网关 WS 错误: ' + JSON.stringify(ws);
  return null;
}

function writeResult(obj) {
  const s = JSON.stringify(obj) + '\n';
  if (RESULT_FILE) {
    try { fs.writeFileSync(RESULT_FILE, s); } catch (_) {}
  }
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return isNaN(n) ? 0 : n; }
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v.low === 'number' && typeof v.high === 'number') {
    const Long = require(path.join(FARM_DIST, 'utils', 'utils')).Long;
    return Long && Long.isLong(v) ? v.toNumber() : 0;
  }
  return 0;
}

(async () => {
  pushLog('SCAN_CODE len=' + SCAN_CODE.length + ' prefix=' + SCAN_CODE.slice(0, 6).replace(/./g, '*'));
  if (!SCAN_CODE) {
    writeResult({ ok: false, error: '缺少 SCAN_CODE' });
    process.exit(1);
  }

  let network, proto, utils;
  try {
    network = require(path.join(FARM_DIST, 'utils', 'network'));
    proto = require(path.join(FARM_DIST, 'utils', 'proto'));
    utils = require(path.join(FARM_DIST, 'utils', 'utils'));
  } catch (e) {
    writeResult({ ok: false, error: '加载农场 bot 模块失败：' + e.message + diagTail() });
    process.exit(1);
  }

  const { connect, sendMsgAsync, getUserState, cleanup, getWsErrorState, networkEvents } = network;
  const { types, loadProto } = proto;

  let context = null;
  let done = false;
  let checkTimer = null;

  const maybeFailFromDiag = () => {
    if (done) return;
    const reason = detectFailure();
    if (reason) fail('网关登录失败：' + reason);
  };

  const fail = (msg) => {
    if (done) return;
    done = true;
    if (checkTimer) clearInterval(checkTimer);
    clearTimeout(totalTimer);
    try { if (context && cleanup) cleanup(context); } catch (_) {}
    const reason = detectFailure();
    const detail = reason && msg.indexOf(reason) === -1 ? '（' + reason + '）' : '';
    writeResult({
      ok: false,
      error: msg + detail + diagTail(),
      diag: { wsErrors: diag.wsErrors, disconnect: diag.disconnect },
    });
    process.exit(1);
  };

  const success = (friends, debug) => {
    if (done) return;
    done = true;
    if (checkTimer) clearInterval(checkTimer);
    clearTimeout(totalTimer);
    try { if (context && cleanup) cleanup(context); } catch (_) {}
    writeResult({
      ok: true,
      self: selfInfo,
      friends,
      count: friends.length,
      debug: debug || null,
    });
    process.exit(0);
  };

  // 监听农场 bot 网络事件，提前感知断连 / WS 错误
  if (networkEvents && typeof networkEvents.on === 'function') {
    networkEvents.on('ws_error', (e) => { diag.wsErrors.push(e); maybeFailFromDiag(); });
    networkEvents.on('disconnected', (e) => { diag.disconnect = e || {}; maybeFailFromDiag(); });
  }
  // 周期性扫描日志，命中鉴权失败/超时等关键词就提前失败
  checkTimer = setInterval(maybeFailFromDiag, 1500);

  const totalTimer = setTimeout(() => fail('网关登录/取好友超时' + diagTail()), TIMEOUT_MS);
  process.on('uncaughtException', (e) => fail('uncaughtException: ' + e.message));
  process.on('unhandledRejection', (e) => fail('unhandledRejection: ' + (e && e.message ? e.message : String(e))));

  let selfInfo = {};

  // 读取 server 通过环境变量传入的「已知好友 gid 种子」（用户手动提供的 872830134 好友 gid，纯真实、零访客）
  const seedGids = (process.env.SEED_GIDS || '')
    .split(/[,\s]+/)
    .map((s) => toNum((s || '').trim()))
    .filter((n) => n > 0);

  // 关键：proto.js 的 types 是 async loadProto() 才填充的（默认是空对象）。
  // 不加这步，types.LoginRequest 为 undefined，connect() 登录时 types.LoginRequest.encode 会抛
  // “Cannot read properties of undefined (reading 'encode')”。主进程启动时已 await 过，子进程必须自己调一次。
  try {
    pushLog('proto: 开始加载 Protobuf 定义...');
    await loadProto();
    if (!types || !types.LoginRequest) {
      fail('Protobuf 定义加载不完整（缺少 LoginRequest），网关登录无法构造请求');
      return;
    }
    pushLog('proto: Protobuf 定义加载完成');
  } catch (e) {
    fail('加载 Protobuf 定义失败：' + e.message + diagTail());
    return;
  }

  try {
    context = await connect(SCAN_CODE, async () => {
      const st = getUserState ? getUserState() : {};
      selfInfo = {
        gid: toNum(st && st.gid),
        name: String((st && st.name) || ''),
        level: toNum(st && st.level),
        openId: String((st && st.openId) || ''),
      };

      const fr = await fetchAllGameFriends(sendMsgAsync, selfInfo.gid, seedGids);
      clearTimeout(totalTimer);
      if (checkTimer) clearInterval(checkTimer);
      success(fr.list, fr.debug);
    });
  } catch (e) {
    clearTimeout(totalTimer);
    if (checkTimer) clearInterval(checkTimer);
    fail('网关登录失败：' + (e && e.message ? e.message : String(e)));
  }
})();

// 扫码取全部好友 GID 的真实路径（已用 proto + 实测确认）：
//   QQ 平台下 FriendService 的「列全部好友」接口 GetAll 被屏蔽（code=1000020），
//   GetGameFriends 必须带已知 gid 才返回（空请求=0）。游戏客户端自己的做法是：
//     1) SyncAll({open_ids:[]}) 拿到候选 gid 池：recommended_friends（在玩本游戏的 QQ 好友）
//        + 双向互加的 game_friends；
//     2) GetGameFriends(候选 gid) 取详情，网关自动过滤「非好友」只留真正的游戏好友。
//   这条链路不依赖访客(InteractRecords)，用的是 QQ 原生好友推荐，即真实好友。
//   可选增强：用户手动种子作为额外候选一起喂给 GetGameFriends。
async function fetchAllGameFriends(sendMsgAsync, selfGid, seedGids) {
  const collected = [];
  const seen = new Set();
  const debug = { syncAllMutual: null, syncAllRecommended: null, candidateInput: null, getGameFriends: null, seed: null };
  const add = (f) => {
    const gid = toNum(f && f.gid);
    if (gid <= 0 || seen.has(gid) || gid === selfGid) return;
    seen.add(gid);
    collected.push(normalizeFriend(f));
  };
  const seed = Array.isArray(seedGids) ? seedGids.filter((g) => g > 0 && g !== selfGid) : [];

  // 1) SyncAll 拿候选 gid 池（推荐好友 + 互加好友）
  let candidateGids = [];
  try {
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', Buffer.alloc(0));
    const sd = decodeSyncAllReply(replyBody);
    debug.syncAllMutual = sd.mutual.length;
    debug.syncAllRecommended = sd.recommended.length;
    candidateGids = Array.from(new Set([...sd.mutual.map((f) => f.gid), ...sd.recommended.map((f) => f.gid)]))
      .filter((g) => g > 0 && g !== selfGid);
    debug.candidateInput = candidateGids.length;
  } catch (e) {
    debug.candidateInput = 'err:' + (e && e.message ? e.message : String(e));
  }

  // 合并用户手动种子（可选增强）
  if (seed.length > 0) {
    candidateGids = Array.from(new Set([...candidateGids, ...seed])).filter((g) => g > 0 && g !== selfGid);
    debug.seed = seed.length;
  }

  // 2) GetGameFriends(候选) → 真实好友（网关自动过滤非好友）
  if (candidateGids.length > 0) {
    try {
      const all = await fetchGameFriendsByGids(sendMsgAsync, candidateGids);
      debug.getGameFriends = all.length;
      for (const f of all) add(f);
    } catch (e) {
      debug.getGameFriends = 'err:' + (e && e.message ? e.message : String(e));
    }
  }

  return { list: collected, debug };
}

// ============ 自研 protobuf 编解码（零依赖 farm-bot 的 FriendService types）============
// 协议从抓包逆向：GetGameFriendsReply / SyncAllReply 的 body 是 repeated GameFriend（field1=message），
// 每个 GameFriend: field1=gid(varint), field2=openid(bytes/string), field3=name(string), field4=head_img(string)…
// GetGameFriendsRequest / SyncAllRequest: field1=repeated uint64 gids（SyncAll 为 open_ids，空数组=空 body）。
function _pbVarint(n) {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out = [];
  while (true) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return Buffer.from(out);
}
function _pbTag(field, wireType) { return _pbVarint((field << 3) | wireType); }
function _readVarint(buf, pos) {
  let shift = 0n, result = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, pos];
}
function _skip(buf, pos, wireType) {
  if (wireType === 0) { const [, p] = _readVarint(buf, pos); return p; }
  if (wireType === 2) { const [len, p] = _readVarint(buf, pos); return p + Number(len); }
  if (wireType === 5) return pos + 4;
  if (wireType === 1) return pos + 8;
  return buf.length;
}
// GetGameFriendsRequest: field1 = repeated uint64 gids；gids 为空 => 空 body => 网关返回全部好友
function encodeGetGameFriends(gids) {
  if (!gids || gids.length === 0) return Buffer.alloc(0);
  let body = Buffer.alloc(0);
  for (const g of gids) body = Buffer.concat([body, _pbTag(1, 0), _pbVarint(g)]);
  return body;
}
function decodeGameFriend(buf) {
  let gid = 0, name = '', headImg = '', openId = '';
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = _readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 0) {
      const [v, np] = _readVarint(buf, p1);
      if (field === 1) gid = Number(v);
      pos = np;
    } else if (wt === 2) {
      const [len, p2] = _readVarint(buf, p1);
      const sub = buf.slice(p2, p2 + Number(len));
      if (field === 2) openId = sub.toString('utf8');
      else if (field === 3) name = sub.toString('utf8');
      else if (field === 4) headImg = sub.toString('utf8');
      pos = p2 + Number(len);
    } else pos = _skip(buf, p1, wt);
  }
  return { gid, name, headImg, openId };
}
function decodeGameFriends(bodyBuf) {
  if (!bodyBuf || bodyBuf.length === 0) return [];
  const friends = [];
  let pos = 0;
  while (pos < bodyBuf.length) {
    const [tag, p1] = _readVarint(bodyBuf, pos);
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (field === 1 && wt === 2) {
      const [len, p2] = _readVarint(bodyBuf, p1);
      const f = decodeGameFriend(bodyBuf.slice(p2, p2 + Number(len)));
      if (f && f.gid) friends.push(f);
      pos = p2 + Number(len);
    } else pos = _skip(bodyBuf, p1, wt);
  }
  return friends;
}

// 取出 repeated message 字段（指定 field 号）的所有子 buffer
function _extractMessageList(buf, fieldNo) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = _readVarint(buf, pos);
    const f = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (f === fieldNo && wt === 2) {
      const [len, p2] = _readVarint(buf, p1);
      out.push(buf.slice(p2, p2 + Number(len)));
      pos = p2 + Number(len);
    } else pos = _skip(buf, p1, wt);
  }
  return out;
}

// RecommendedFriend: gid=1, name=2, avatar_url=3, level=4, open_id=6
function decodeRecommended(buf) {
  let gid = 0, name = '', avatar = '', openId = '', level = 0;
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = _readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 0) {
      const [v, np] = _readVarint(buf, p1);
      if (field === 1) gid = Number(v);
      else if (field === 4) level = Number(v);
      pos = np;
    } else if (wt === 2) {
      const [len, p2] = _readVarint(buf, p1);
      const sub = buf.slice(p2, p2 + Number(len));
      if (field === 2) name = sub.toString('utf8');
      else if (field === 3) avatar = sub.toString('utf8');
      else if (field === 6) openId = sub.toString('utf8');
      pos = p2 + Number(len);
    } else pos = _skip(buf, p1, wt);
  }
  return { gid, name, avatar, openId, level };
}

// SyncAllReply: game_friends(互加, field1) + recommended_friends(推荐好友, field5)
function decodeSyncAllReply(bodyBuf) {
  if (!bodyBuf || bodyBuf.length === 0) return { mutual: [], recommended: [] };
  const mutual = _extractMessageList(bodyBuf, 1).map(decodeGameFriend).filter((f) => f && f.gid);
  const recommended = _extractMessageList(bodyBuf, 5).map(decodeRecommended).filter((f) => f && f.gid);
  return { mutual, recommended };
}

// GetGameFriends（自研编码/解码）：
//   - gids 为空 => 请求体为空 => 网关返回 0（空请求不会返回全部；GetAll 才列全部但被 QQ 屏蔽）
//   - gids 非空 => 按 gid 批量取详情（网关自动过滤非好友，只返回真正的好友）
async function fetchGameFriendsByGids(sendMsgAsync, gids) {
  const body = encodeGetGameFriends(gids);
  const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body);
  return decodeGameFriends(replyBody);
}

function normalizeFriend(f) {
  const avatar = String((f && (f.head_img || f.avatar || f.headImg || f.icon)) || '');
  // 系统号/机器人：gid 为知名系统号，或头像不是 http(s) 外链（如本地 gui/texture/.../img_botHeadN）
  const gid = toNum(f && f.gid);
  const isSystem = gid === 10001 || (avatar && !/^https?:\/\//i.test(avatar));
  return {
    gid: String(gid),
    openId: String((f && (f.open_id || f.openId)) || ''),
    name: String((f && f.name) || ''),
    level: Number((f && f.level) || 0),
    gold: Number((f && f.gold) || 0),
    avatar: avatar,
    isSystem: !!isSystem,
  };
}
