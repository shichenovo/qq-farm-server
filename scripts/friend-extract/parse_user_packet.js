const path = require("path");
const FARM = "/opt/qq-farm-bot-3010/core/dist";
const proto = require(path.join(FARM, "utils", "proto"));
const dec = require("/opt/napcat-code-web/_decoder_only.js");

// 用户贴的 field 3 base64（原始包体）
const B64 = "gOMaxPrXXafI0CZGvHVhAJr87pHTmh7hWmSXIsZzL525QepnfDUiZl3SB7DNpcN8HIPwrLX0qWytxRLuQW0HWRVmwALqYE=";
const buf = Buffer.from(B64, "base64");
console.log("base64 解码字节数:", buf.length);
console.log("hex:", buf.toString("hex"));

function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : (v? v.toString(): 0); }

(async () => {
  await proto.loadProto();
  const T = proto.types;

  function tryDecode(name, fn){
    try { const r = fn(); console.log("\n=== "+name+" 成功 ==="); return r; }
    catch(e){ console.log("\n--- "+name+" 失败:", e.message); return null; }
  }

  // 1) 直接当 GetGameFriendsReply / GetAllFriendsReply
  for (const tn of ["GetGameFriendsReply","GetAllFriendsReply","GetGameFriendsResponse"]){
    if (T[tn]){
      tryDecode(tn, () => {
        const r = T[tn].decode(buf);
        const gf = (r.game_friends||r.friends||[]);
        console.log(tn, "好友数:", gf.length);
        gf.slice(0,30).forEach(f=>console.log("  gid=",toNum(f.gid),"name=",f.name,"lv=",toNum(f.level)));
        return r;
      });
    }
  }

  // 2) 当 GateMessage（外层信封）
  tryDecode("GateMessage", () => {
    const g = T.GateMessage.decode(buf);
    console.log("meta:", JSON.stringify(g.meta));
    const body = g.body ? Buffer.from(g.body) : Buffer.alloc(0);
    console.log("body 字节数:", body.length);
    // 再试 body 当作 GetGameFriendsReply
    for (const tn of ["GetGameFriendsReply","GetAllFriendsReply"]){
      if (T[tn]){
        try { const r = T[tn].decode(body); const gf=r.game_friends||r.friends||[]; console.log("  body as "+tn+" 好友数:", gf.length); gf.slice(0,30).forEach(f=>console.log("    gid=",toNum(f.gid),"name=",f.name)); } catch(e){ console.log("  body as "+tn+" 失败:", e.message); }
      }
    }
    return g;
  });

  // 3) 当 EventMessage
  tryDecode("EventMessage", () => {
    const em = T.EventMessage.decode(buf);
    console.log("message_type:", em.message_type, "body 字节数:", em.body? em.body.length:0);
    if (em.body){
      const body = Buffer.from(em.body);
      for (const tn of ["GetGameFriendsReply","GetAllFriendsReply"]){
        if (T[tn]){ try { const r=T[tn].decode(body); const gf=r.game_friends||r.friends||[]; console.log("  EM.body as "+tn+" 好友数:",gf.length); gf.slice(0,30).forEach(f=>console.log("    gid=",toNum(f.gid))); } catch(e){} }
      }
    }
    return em;
  });

  // 4) 手写好用的解码器
  tryDecode("decodeGameFriends", () => { const gf = dec.decodeGameFriends(buf); console.log("好友数:", gf.length); gf.slice(0,30).forEach(f=>console.log("  gid=",toNum(f.gid),"name=",f.name,"lv=",toNum(f.level))); return gf; });
  tryDecode("decodeSyncAllReply", () => { const sa = dec.decodeSyncAllReply(buf); console.log("mutual:", sa.mutual.length, "recommended:", sa.recommended.length); });

  // 5) 原始 varint 扫描，找 gid 区间数字
  console.log("\n=== 原始 varint 扫描 (gid 区间 1e7~4e9) ===");
  const gids = new Set();
  let i = 0;
  while (i < buf.length){
    let shift=0, val=0, byte;
    do { byte = buf[i++]; val |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80 && i < buf.length);
    if (val >= 1e7 && val <= 4e9) gids.add(val);
  }
  console.log("候选 gid 数:", gids.size);
  console.log([...gids].slice(0,40).join(", "));
})().catch(e=>console.log("FATAL", e.message));
