// 终极验证：用客户端完整参数(QQ/Android/ver)登录，全量抓包 + 多接口探测，确认 27 好友是否在纯 code 场景下可达
'use strict';
const fs = require('fs');
const path = require('path');

const FARM_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';
const SCAN_CODE = (process.env.SCAN_CODE || '').trim();
const RESULT_FILE = process.env.SCAN_RESULT_FILE || '/tmp/ffq-result.json';
const TIMEOUT_MS = Math.max(40000, parseInt(process.env.SCAN_GIDS_TIMEOUT || '150000', 10));
const LISTEN_MS = Math.max(15000, parseInt(process.env.LISTEN_MS || '40000', 10));
const CAP = '/tmp/ws-capture-qq.jsonl';

const pushLog = (m) => { try { fs.appendFileSync('/tmp/ffq.log', m + '\n'); } catch (_) {} };
const writeResult = (o) => { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'object') { if (v && typeof v.toNumber === 'function') return v.toNumber(); return Number(v) || 0; }
  return Number(v) || 0;
}

(async () => {
  fs.writeFileSync('/tmp/ffq.log', '');
  fs.writeFileSync(CAP, '');
  pushLog('SCAN_CODE len=' + SCAN_CODE.length);
  if (!SCAN_CODE) { writeResult({ ok: false, error: '缺少 SCAN_CODE' }); process.exit(1); }

  // 覆盖 CONFIG 为客户端参数（需在 require network 之前改，确保同一模块实例）
  const cfgMod = require(path.join(FARM_DIST, 'config', 'config'));
  if (cfgMod && cfgMod.CONFIG) {
    cfgMod.CONFIG.os = 'Android';
    cfgMod.CONFIG.clientVersion = '1.13.3.16_20260826';
    cfgMod.CONFIG.deviceInfo = cfgMod.CONFIG.deviceInfo || {};
    cfgMod.CONFIG.deviceInfo.os = 'Android';
    cfgMod.CONFIG.deviceInfo.userAgent = 'Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.231003.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1165009 MMWEBSDK/20240407 MiniProgramEnv/android MicroMessenger/8.0.49.2680(0x28003137) NetType/WIFI Language/zh_CN ABI/arm64';
    pushLog('CONFIG 覆盖: platform=' + cfgMod.CONFIG.platform + ' os=' + cfgMod.CONFIG.os + ' ver=' + cfgMod.CONFIG.clientVersion);
  }

  let network, proto, dec;
  try {
    network = require(path.join(FARM_DIST, 'utils', 'network'));
    proto = require(path.join(FARM_DIST, 'utils', 'proto'));
    dec = require('/opt/napcat-code-web/_decoder_only.js');
  } catch (e) { writeResult({ ok: false, error: '加载 bot 模块失败：' + e.message }); process.exit(1); }

  const { connect, sendMsgAsync, getUserState, cleanup } = network;
  const { types, loadProto } = proto;

  let done = false;
  const finish = (obj, code) => { if (done) return; done = true; try { cleanup && cleanup(); } catch (_) {} writeResult(obj); process.exit(code); };
  const totalTimer = setTimeout(() => finish({ ok: false, error: '超时' }, 1), TIMEOUT_MS);
  process.on('uncaughtException', (e) => finish({ ok: false, error: 'uncaught: ' + e.message }, 1));
  process.on('unhandledRejection', (e) => finish({ ok: false, error: 'unhandled: ' + ((e && e.message) || String(e)) }, 1));

  let selfInfo = {};
  const candidateGids = [];
  const realFriends = [];
  const packets = [];

  await loadProto();
  if (!types || !types.GateMessage) { finish({ ok: false, error: 'Protobuf 未加载' }, 1); return; }

  const T = require(path.join(FARM_DIST, 'utils', 'proto')).types;
  const GM = T.GateMessage;
  if (GM && GM.decode) {
    const orig = GM.decode.bind(GM);
    GM.decode = function (buf) {
      try {
        const m = orig(buf);
        try {
          const meta = m && m.meta ? m.meta : {};
          const body = m && m.body ? Buffer.from(m.body) : Buffer.alloc(0);
          const tag = String(meta.service_name || '') + '.' + String(meta.method_name || '');
          let fc = 0; try { fc = dec.decodeGameFriends(body).length; } catch (_) {}
          packets.push({ n: packets.length + 1, t: Number(meta.message_type), m: tag, err: Number(meta.error_code), len: body.length, fc });
        } catch (_) {}
      } catch (e) { return orig(buf); }
      return orig(buf);
    };
  }

  try {
    await connect(SCAN_CODE, async () => {
      const st = getUserState ? getUserState() : {};
      selfInfo = { gid: toNum(st && st.gid), name: String((st && st.name) || ''), level: toNum(st && st.level), openId: String((st && st.openId) || '') };
      pushLog('登录成功: ' + selfInfo.name + ' (Lv' + selfInfo.level + ') gid=' + selfInfo.gid + ' openId=' + selfInfo.openId);

      const probes = [
        ['gamepb.friendpb.FriendService', 'SyncAll', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetAllFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'SyncAllFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetGameFriends', Buffer.alloc(0)],
        ['gamepb.friendpb.FriendService', 'GetApplications', Buffer.alloc(0)],
        ['gamepb.interactpb.InteractService', 'InteractRecords', Buffer.alloc(0)],
        ['gamepb.interactpb.InteractService', 'GetInteractRecords', Buffer.alloc(0)],
        ['gamepb.interactpb.VisitorService', 'InteractRecords', Buffer.alloc(0)],
      ];
      for (const [svc, m, b] of probes) {
        const tag = svc + '.' + m;
        try {
          const { body } = await sendMsgAsync(svc, m, b, { timeoutMs: 10000 });
          const gfs = dec.decodeGameFriends(body);
          for (const f of gfs) { const g = toNum(f.gid); if (g > 0 && g !== selfInfo.gid) candidateGids.push(g); }
          pushLog('probe ' + tag + ' -> ' + gfs.length + ' gids');
        } catch (e) { pushLog('probe ' + tag + ' err: ' + e.message); }
        await sleep(500);
      }

      const uniq = Array.from(new Set(candidateGids));
      pushLog('候选去重: ' + uniq.length);

      // 用候选验证真好友
      for (let i = 0; i < uniq.length; i += 35) {
        const batch = uniq.slice(i, i + 35);
        try {
          const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({ gids: batch })).finish();
          const { body: repBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body, { timeoutMs: 12000 });
          let reply;
          try { reply = types.GetAllFriendsReply.decode(repBody); } catch (_) { reply = types.GetGameFriendsReply.decode(repBody); }
          const fs2 = (reply && (reply.game_friends || reply.gameFriends)) || [];
          for (const f of fs2) realFriends.push({ gid: toNum(f.gid), name: String(f.name || ''), level: toNum(f.level), openId: String(f.open_id || '') });
        } catch (e) { pushLog('GetGameFriends batch err: ' + e.message); }
        await sleep(500);
      }

      const seen = new Set(); const final = [];
      for (const f of realFriends) { if (f.gid > 0 && !seen.has(f.gid)) { seen.add(f.gid); final.push(f); } }

      // 长监听，捕获可能的好友推送（如 FriendListSync 等）
      await sleep(LISTEN_MS);

      clearTimeout(totalTimer);
      finish({ ok: true, self: selfInfo, candidateCount: uniq.length, friendCount: final.length, friends: final, packets }, 0);
    });
  } catch (e) {
    clearTimeout(totalTimer);
    finish({ ok: false, error: '登录失败：' + ((e && e.message) || String(e)) }, 1);
  }
})();
