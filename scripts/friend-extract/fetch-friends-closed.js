// 闭环：登录 -> 抓 InteractRecords 拿候选 gid -> 分批 GetGameFriends 验证 -> 输出带详情真好友
'use strict';
const fs = require('fs');
const path = require('path');

const FARM_DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';
const SCAN_CODE = (process.env.SCAN_CODE || '').trim();
const RESULT_FILE = process.env.SCAN_RESULT_FILE || '/tmp/ffc-result.json';
const DEC = '/opt/napcat-code-web/_decoder_only.js';
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.SCAN_GIDS_TIMEOUT || '120000', 10));

const pushLog = (m) => { try { fs.appendFileSync('/tmp/ffc.log', m + '\n'); } catch (_) {} };
const writeResult = (o) => { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'object') { if (v && typeof v.toNumber === 'function') return v.toNumber(); return Number(v) || 0; }
  return Number(v) || 0;
}

(async () => {
  fs.writeFileSync('/tmp/ffc.log', '');
  pushLog('SCAN_CODE len=' + SCAN_CODE.length);
  if (!SCAN_CODE) { writeResult({ ok: false, error: '缺少 SCAN_CODE' }); process.exit(1); }

  let network, proto, dec;
  try {
    network = require(path.join(FARM_DIST, 'utils', 'network'));
    proto = require(path.join(FARM_DIST, 'utils', 'proto'));
    dec = require(DEC);
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
  const diag = []; // 包摘要

  // 轻量 hook：记录每个入站包的 service/method/friendCount，便于确认 InteractRecords / GetGameFriends 如期返回
  const protoMod = require(path.join(FARM_DIST, 'utils', 'proto'));

  await loadProto();
  if (!types || !types.GetGameFriendsRequest) { finish({ ok: false, error: 'Protobuf 定义不完整' }, 1); return; }

  const T = protoMod.types;
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
          let fc = 0;
          try { fc = dec.decodeGameFriends(body).length; } catch (_) {}
          diag.push({ t: Number(meta.message_type), m: tag, err: Number(meta.error_code), fc });
        } catch (_) {}
      } catch (e) { return orig(buf); }
      return orig(buf);
    };
  }

  try {
    await connect(SCAN_CODE, async () => {
      const st = getUserState ? getUserState() : {};
      selfInfo = { gid: toNum(st && st.gid), name: String((st && st.name) || ''), level: toNum(st && st.level), openId: String((st && st.openId) || '') };
      pushLog('登录成功: ' + selfInfo.name + ' (Lv' + selfInfo.level + ') gid=' + selfInfo.gid);

      // 1) 抓 InteractRecords 候选（空请求，已验证返回 201 gid）
      try {
        const { body } = await sendMsgAsync('gamepb.interactpb.InteractService', 'InteractRecords', Buffer.alloc(0), { timeoutMs: 12000 });
        const gfs = dec.decodeGameFriends(body);
        for (const f of gfs) { const g = toNum(f.gid); if (g > 0 && g !== selfInfo.gid) candidateGids.push(g); }
        pushLog('InteractRecords 候选原始: ' + candidateGids.length);
      } catch (e) { pushLog('InteractRecords err: ' + e.message); }

      const uniq = Array.from(new Set(candidateGids));
      pushLog('候选去重后: ' + uniq.length);

      // 2) 分批 GetGameFriends 验证
      for (let i = 0; i < uniq.length; i += 35) {
        const batch = uniq.slice(i, i + 35);
        try {
          const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({ gids: batch })).finish();
          const { body: repBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body, { timeoutMs: 12000 });
          let reply;
          try { reply = types.GetAllFriendsReply.decode(repBody); } catch (_) { reply = types.GetGameFriendsReply.decode(repBody); }
          const fs2 = (reply && (reply.game_friends || reply.gameFriends)) || [];
          for (const f of fs2) realFriends.push({ gid: toNum(f.gid), name: String(f.name || ''), level: toNum(f.level), openId: String(f.open_id || '') });
          pushLog('GetGameFriends 批 ' + (i + 1) + '-' + (i + batch.length) + ' -> ' + fs2.length + ' 真好友');
        } catch (e) { pushLog('GetGameFriends 批 err: ' + e.message); }
        await sleep(500);
      }

      // 去重
      const seen = new Set(); const final = [];
      for (const f of realFriends) { if (f.gid > 0 && !seen.has(f.gid)) { seen.add(f.gid); final.push(f); } }

      clearTimeout(totalTimer);
      finish({ ok: true, self: selfInfo, candidateCount: uniq.length, friendCount: final.length, friends: final, diag }, 0);
    });
  } catch (e) {
    clearTimeout(totalTimer);
    finish({ ok: false, error: '登录失败：' + ((e && e.message) || String(e)) }, 1);
  }
})();
