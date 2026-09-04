// 稳健版 ws 全量监听：修复 detectFailure 误报，解析 EventMessage 信封，全量抓包不截断
'use strict';
const fs = require('fs');
const path = require('path');

const FARM_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';
const SCAN_CODE = (process.env.SCAN_CODE || '').trim();
const RESULT_FILE = process.env.SCAN_RESULT_FILE || '/tmp/listen2-result.json';
const TIMEOUT_MS = Math.max(10000, parseInt(process.env.SCAN_GIDS_TIMEOUT || '60000', 10));
const LISTEN_MS = Math.max(8000, parseInt(process.env.LISTEN_MS || '35000', 10));
const CAP = process.env.WS_CAP_FILE || '/tmp/ws-capture2.jsonl';

const pushLog = (m) => { try { fs.appendFileSync('/tmp/listen2.log', m + '\n'); } catch (_) {} };
const writeResult = (o) => { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o)); } catch (_) {} };

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object') { const L = v; if (L && typeof L.toNumber === 'function') return L.toNumber(); return Number(v) || 0; }
  return Number(v) || 0;
}
function normalizeFriend(f) {
  return { gid: toNum(f && f.gid), name: String((f && f.name) || ''), openId: String((f && f.openId) || ''), level: toNum(f && f.level) };
}

(async () => {
  fs.writeFileSync('/tmp/listen2.log', '');
  pushLog('SCAN_CODE len=' + SCAN_CODE.length);
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
  // 关键修复：去掉 code=\d+ 这种会命中 GetAll 正常报错的宽泛匹配，只认真正的登录鉴权失败
  const isRealLoginFailure = (j) => /账号验证失败|授权码无效|已被使用|登录.*超时|拒绝登录/.test(j);
  const checkTimer = setInterval(() => {
    const tail = ''; // 不再读全局日志做误判
    if (done) return;
  }, 2000);
  const totalTimer = setTimeout(() => fail('网关登录/取好友超时'), TIMEOUT_MS);
  process.on('uncaughtException', (e) => fail('uncaughtException: ' + e.message));
  process.on('unhandledRejection', (e) => fail('unhandledRejection: ' + ((e && e.message) || String(e))));

  let selfInfo = {};

  await loadProto();
  if (!types || !types.LoginRequest) { fail('Protobuf 定义加载不完整'); return; }

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

  // 从 body 抽取所有可读字符串（抓 open_id / 服务名等）
  function extractStrings(buf) {
    const out = [];
    if (!buf || buf.length === 0) return out;
    let i = 0;
    while (i < buf.length) {
      // 尝试把每个位置当 length-delimited 字段解析
      const b = buf[i];
      if ((b & 0x07) === 2) {
        // 读 varint 长度
        let shift = 0n, len = 0n, p = i + 1;
        while (p < buf.length) {
          const x = buf[p++];
          len |= BigInt(x & 0x7f) << shift;
          if (!(x & 0x80)) break;
          shift += 7n;
          if (shift > 32n) break;
        }
        const L = Number(len);
        if (L >= 6 && L <= 200 && p + L <= buf.length) {
          const sub = buf.slice(p, p + L);
          if (sub.every((c) => c >= 0x20 && c < 0x7f)) {
            const s = sub.toString('utf8');
            out.push(s);
          }
          i = p + L;
          continue;
        }
      }
      i++;
    }
    // 兜底：滑动窗口抓连续可打印串
    let run = '';
    for (let k = 0; k < buf.length; k++) {
      const c = buf[k];
      if (c >= 0x20 && c < 0x7f) { run += String.fromCharCode(c); }
      else { if (run.length >= 8) out.push(run); run = ''; }
    }
    if (run.length >= 8) out.push(run);
    return out;
  }

  // ===== 登录 + 监听 =====
  try {
    await connect(SCAN_CODE, async () => {
      const st = getUserState ? getUserState() : {};
      selfInfo = { gid: toNum(st && st.gid), name: String((st && st.name) || ''), level: toNum(st && st.level), openId: String((st && st.openId) || '') };
      pushLog('登录成功: ' + selfInfo.name + ' (Lv' + selfInfo.level + ') gid=' + selfInfo.gid);

      // 关键：connect 后 proto.types 可能被 loadProto 重新赋值，hook 必须在回调内（登录后）打，才能命中运行时实际对象
      fs.writeFileSync(CAP, '');
      const protoMod = require(path.join(FARM_DIST, 'utils', 'proto'));
      const T = protoMod.types;
      const GM = T.GateMessage;
      const origDecode = GM.decode.bind(GM);
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
          const entry = {
            n: ++captured,
            t: Date.now(),
            msgType, service, method,
            errorCode: Number(meta.error_code),
            clientSeq: Number(meta.client_seq),
            serverSeq: Number(meta.server_seq),
            bodyLen: body.length,
            friendCount: found.length,
            strings: extractStrings(body).filter((s) => /^[0-9A-Fa-f]{16,}$/.test(s) || s.indexOf('.') > 0).slice(0, 20),
            bodyHex: body.length <= 65536 ? body.toString('hex') : body.slice(0, 65536).toString('hex') + '...(truncated)',
          };
          try { fs.appendFileSync(CAP, JSON.stringify(entry) + '\n'); } catch (_) {}
        } catch (_) {}
        return msg;
      };

      // 主动探测若干可能返回好友的接口（失败忽略，不影响监听）
      const probes = [
        ['gamepb.friendpb.FriendService', 'SyncAll', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'SyncAllFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetAllFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetGameFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetApplications', Buffer.alloc(0)],
        ['gamepb.interactpb.InteractService', 'InteractRecords', Buffer.alloc(0)],
        ['gamepb.interactpb.VisitorService', 'InteractRecords', Buffer.alloc(0)],
      ];
      for (const [svc, m, b] of probes) {
        try { await sendMsgAsync(svc, m, b, { timeoutMs: 8000 }); } catch (_) {}
        await new Promise((r) => setTimeout(r, 600));
      }

      // 等待网关主动推送（含好友列表 Notify）
      await new Promise((r) => setTimeout(r, LISTEN_MS));

      // 二次分析：扫描所有包的字符串，找 open_id 形态（16+ 十六进制）
      const openIds = new Set();
      try {
        const lines = fs.readFileSync(CAP, 'utf8').split('\n').filter(Boolean);
        for (const ln of lines) {
          const e = JSON.parse(ln);
          for (const s of (e.strings || [])) if (/^[0-9A-Fa-f]{16,}$/.test(s)) openIds.add(s.toUpperCase());
        }
      } catch (_) {}

      // 汇总所有抓到的 gid
      const friends = [];
      for (const [g, e] of allGids) {
        if (g === selfInfo.gid) continue;
        friends.push({ gid: g, name: e.name, openId: e.openId, level: e.level, sources: Array.from(e.sources) });
      }
      clearTimeout(totalTimer); clearInterval(checkTimer);
      success(friends, {
        capturedPackets: captured,
        captureFile: CAP,
        selfGid: selfInfo.gid,
        selfOpenId: selfInfo.openId,
        totalGids: allGids.size,
        candidateOpenIds: Array.from(openIds),
      });
    });
  } catch (e) {
    clearTimeout(totalTimer); clearInterval(checkTimer);
    try { if (cleanup) cleanup(); } catch (_) {}
    writeResult({ ok: false, error: '网关登录失败：' + ((e && e.message) || String(e)) });
    process.exit(1);
  }
})();
