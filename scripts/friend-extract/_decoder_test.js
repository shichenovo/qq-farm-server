
// 离线校验：用 bot 的 proto 定义编码 SyncAllReply，再用自研解码器解码，比对结果
const path = require('path');
const DIST = process.env.FARM_BOT_DIST || '/opt/qq-farm-bot-3010/core/dist';

const dec = require('/opt/napcat-code-web/_decoder_only.js');

(async () => {
  const proto = require(path.join(DIST, 'utils', 'proto'));
  const { loadProto, types } = proto;
  await loadProto();

  const T = types.SyncAllReply || types.SyncAllFriendsReply;
  if (!T) { console.log('FAIL: proto 里找不到 SyncAllReply'); process.exit(1); }
  console.log('proto 类型名: SyncAllReply =', !!types.SyncAllReply,
              '| SyncAllFriendsReply =', !!types.SyncAllFriendsReply);

  // 构造 27 个互加好友 + 6 个推荐好友
  const gids = [];
  for (let i = 0; i < 27; i++) gids.push(1000000000 + i * 7);
  const recGids = [];
  for (let i = 0; i < 6; i++) recGids.push(2000000000 + i * 13);

  const payload = {
    game_friends: gids.map((g, i) => ({
      gid: g,
      open_id: 'OPENID' + String(i),
      name: '好友' + i,
      avatar_url: 'https://example.com/a' + i + '.png',
      level: 10 + i,
      exp: 1234 + i,
      gold: 5000 + i,
    })),
    application_count: 3,
    recommended_friends: recGids.map((g, i) => ({
      gid: g,
      name: '推荐' + i,
      avatar_url: 'https://example.com/r' + i + '.png',
      level: 20 + i,
      open_id: 'ROPENID' + i,
    })),
  };

  const buf = Buffer.from(T.encode(T.create(payload)).finish());
  console.log('proto 编码后 body 字节数 =', buf.length);

  const out = dec.decodeSyncAllReply(buf);
  const gotMutual = out.mutual.map((f) => f.gid);
  const gotRec = out.recommended.map((f) => f.gid);

  console.log('--- 自研解码结果 ---');
  console.log('  mutual    解码数 =', gotMutual.length, '(期望 27)');
  console.log('  recommended 解码数 =', gotRec.length, '(期望 6)');

  const missMutual = gids.filter((g) => !gotMutual.includes(g));
  const missRec = recGids.filter((g) => !gotRec.includes(g));
  console.log('  漏掉的 mutual gid =', missMutual.length ? missMutual.slice(0, 10) : '无');
  console.log('  漏掉的 recommended gid =', missRec.length ? missRec.slice(0, 10) : '无');

  const sample = out.mutual[0] || {};
  console.log('  首条样例 =', JSON.stringify(sample));

  const ok = gotMutual.length === 27 && gotRec.length === 6 && missMutual.length === 0 && missRec.length === 0;
  console.log(ok ? 'DECODER_OK: 解码器完全正确' : 'DECODER_FAIL: 解码器有 bug');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log('ERROR:', e && e.message); process.exit(2); });
