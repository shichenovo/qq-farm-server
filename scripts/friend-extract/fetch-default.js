// 最终默认参数脚本：登录 -> 全量抓包(解密后) -> 收集候选 gid -> GetGameFriends 验证 -> 输出带详情真好友
// 不覆盖任何平台/版本参数，使用 bot CONFIG 默认值（与之前 c7ce/5092/631eda 能登录的脚本一致）
'use strict';
const fs = require('fs');
const path = require('path');

const FARM_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';
const SCAN_CODE = (process.env.SCAN_CODE || '').trim();
const RESULT_FILE = process.env.SCAN_RESULT_FILE || '/tmp/fd-result.json';
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.SCAN_GIDS_TIMEOUT || '140000', 10));
const LISTEN_MS = Math.max(8000, parseInt(process.env.LISTEN_MS || '38000', 10));
const CAP = process.env.WS_CAP_FILE || '/tmp/fd-capture.jsonl';

const pushLog = (m) => { try { fs.appendFileSync('/tmp/fd.log', m + '\n'); } catch (_) {} };
const writeResult = (o) => { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o)); } catch (_) {} };

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object') { const L = v; if (L && typeof L.toNumber === 'function') return L.toNumber(); return Number(v) || 0; }
  return Number(v) || 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.writeFileSync('/tmp/fd.log', '');
  pushLog('[默认参数] SCAN_CODE len=' + SCAN_CODE.length);
  if (!SCAN_CODE) { writeResult({ ok: false, error: '缺少 SCAN_CODE' }); process.exit(1); }

  let network, proto;
  try {
    network = require(path.join(FARM_DIST, 'utils', 'network'));
    proto = require(path.join(FARM_DIST, 'utils', 'proto'));
  } catch (e) { writeResult({ ok: false, error: '加载 bot 模块失败：' + e.message }); process.exit(1); }

  const { connect, sendMsgAsync, getUserState, cleanup } = network;
  const { types, loadProto } = proto;
  const dec = require('/opt/napcat-code-web/_decoder_only.js');

  let done = false;
  const success = (friends, debug) => {
    if (done) return; done = true;
    try { if (cleanup) cleanup(); } catch (_) {}
    writeResult({ ok: true, self: selfInfo, friends, count: friends.length, debug: debug || null });
    process.exit(0);
  };
  const fail = (msg) => {
    if (done) return; done = true;
    try { if (cleanup) cleanup(); } catch (_) {}
    writeResult({ ok: false, error: msg });
    process.exit(1);
  };

  const totalTimer = setTimeout(() => fail('网关登录/取好友超时'), TIMEOUT_MS);
  process.on('uncaughtException', (e) => fail('uncaughtException: ' + e.message));
  process.on('unhandledRejection', (e) => fail('unhandledRejection: ' + ((e && e.message) || String(e))));

  let selfInfo = {};
  await loadProto();
  if (!types || !types.GateMessage) { fail('Protobuf 定义加载不完整'); return; }

  let captured = 0;
  const allGids = new Map();
  const addGid = (g, info, src) => {
    if (!g || g <= 0) return;
    if (!allGids.has(g)) allGids.set(g, { gid: g, name: '', openId: '', level: 0, sources: new Set() });
    const e = allGids.get(g);
    e.sources.add(src);
    if (info) { if (info.name) e.name = info.name; if (info.openId) e.openId = info.openId; if (info.level) e.level = info.level; }
  };

  function extractFriends(buf, srcTag, isEventMessage) {
    if (!buf || buf.length === 0) return [];
    let scan = buf;
    const ty = require(path.join(FARM_DIST, 'utils', 'proto')).types;
    if (isEventMessage) {
      try {
        const em = ty.EventMessage.decode(buf);
        srcTag = (em.message_type || srcTag || '') + '(EM)';
        scan = em.body && em.body.length ? Buffer.from(em.body) : Buffer.alloc(0);
      } catch (_) { scan = buf; }
    }
    const found = [];
    const gf = dec.decodeGameFriends(scan);
    for (const f of gf) { addGid(toNum(f.gid), { name: f.name, openId: f.openId, level: f.level }, srcTag + ':GameFriends'); found.push(f); }
    try {
      const sa = dec.decodeSyncAllReply(scan);
      for (const f of sa.mutual) { addGid(toNum(f.gid), { name: f.name, openId: f.openId, level: f.level }, srcTag + ':SyncAllMutual'); found.push(f); }
      for (const f of sa.recommended) { addGid(toNum(f.gid), { name: f.name, openId: f.openId, level: f.level }, srcTag + ':SyncAllRec'); found.push(f); }
    } catch (_) {}
    try {
      const ap = ty.FriendApplicationReceivedNotify.decode(scan);
      if (ap && ap.applications) for (const a of ap.applications) { addGid(toNum(a.gid), { name: a.name, openId: a.open_id }, srcTag + ':Applications'); found.push(a); }
    } catch (_) {}
    return found;
  }

  // ===== 登录 + 监听 + 验证 =====
  try {
    await connect(SCAN_CODE, async () => {
      const st = getUserState ? getUserState() : {};
      selfInfo = { gid: toNum(st && st.gid), name: String((st && st.name) || ''), level: toNum(st && st.level), openId: String((st && st.openId) || '') };
      pushLog('登录成功: ' + selfInfo.name + ' (Lv' + selfInfo.level + ') gid=' + selfInfo.gid);

      fs.writeFileSync(CAP, '');
      const protoMod = require(path.join(FARM_DIST, 'utils', 'proto'));
      const T = protoMod.types;
      const GM = T.GateMessage;
      const origDecode = GM.decode.bind(GM);
      const packets = [];
      GM.decode = function (buf) {
        let msg;
        try { msg = origDecode(buf); } catch (e) { return origDecode(buf); }
        try {
          const meta = msg && msg.meta ? msg.meta : {};
          const body = msg && msg.body ? Buffer.from(msg.body) : Buffer.alloc(0);
          const msgType = Number(meta.message_type);
          const service = String(meta.service_name || '');
          const method = String(meta.method_name || '');
          const srcTag = service + (method ? '.' + method : '');
          const found = extractFriends(body, srcTag, msgType === 3);
          const entry = { n: ++captured, t: Date.now(), msgType, service, method, errorCode: Number(meta.error_code), friendCount: found.length, bodyLen: body.length };
          packets.push(entry);
          try { fs.appendFileSync(CAP, JSON.stringify(entry) + '\n'); } catch (_) {}
        } catch (_) {}
        return msg;
      };

      // 主动探测
      const probes = [
        ['gamepb.friendpb.FriendService', 'SyncAll', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetGameFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetApplications', Buffer.alloc(0)],
        ['gamepb.interactpb.InteractService', 'InteractRecords', Buffer.alloc(0)],
        ['gamepb.interactpb.VisitorService', 'InteractRecords', Buffer.alloc(0)],
      ];
      for (const [svc, m, b] of probes) {
        try { await sendMsgAsync(svc, m, b, { timeoutMs: 8000 }); } catch (_) {}
        await sleep(600);
      }

      // 等待网关主动推送
      await sleep(LISTEN_MS);

      // 候选 gid（排除自己）
      const candidates = [];
      for (const [g, e] of allGids) { if (g !== selfInfo.gid) candidates.push(g); }
      pushLog('候选 gid 数(来自所有包): ' + candidates.length + ' 抓包数: ' + captured);

      // GetGameFriends 分批验证（默认 batch 35）
      const BATCH = 35;
      const verified = [];
      for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        try {
          const req = T.GetGameFriendsRequest.create({ gids: batch.map((x) => Number(x)) });
          const body = T.GetGameFriendsRequest.encode(req).finish();
          const resp = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body, { timeoutMs: 10000 });
          const rb = resp && resp.body ? Buffer.from(resp.body) : Buffer.alloc(0);
          const gf = dec.decodeGameFriends(rb);
          for (const f of gf) verified.push({ gid: toNum(f.gid), name: String(f.name || ''), openId: String(f.openId || ''), level: toNum(f.level) });
        } catch (_) {}
        await sleep(400);
      }
      pushLog('GetGameFriends 验证后真好友数: ' + verified.length);

      clearTimeout(totalTimer);
      success(verified, {
        capturedPackets: captured,
        captureFile: CAP,
        selfGid: selfInfo.gid,
        candidateCount: candidates.length,
        friendCount: verified.length,
        packets: packets.map((p) => ({ n: p.n, t: p.msgType, s: p.service, m: p.method, err: p.errorCode, fc: p.friendCount })),
      });
    });
  } catch (e) {
    clearTimeout(totalTimer);
    try { if (cleanup) cleanup(); } catch (_) {}
    writeResult({ ok: false, error: '网关登录失败：' + ((e && e.message) || String(e)) });
    process.exit(1);
  }
})();
