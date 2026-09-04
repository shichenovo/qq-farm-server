// 自动抽取：仅用于离线校验，不参与线上运行
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

module.exports = {
  decodeSyncAllReply,
  decodeGameFriends,
  decodeGameFriend,
  decodeRecommended,
  encodeGetGameFriends,
};
