#!/usr/bin/env bash
# ============================================================
# verify-deploy.sh — 部署/升级后一键体检
# 用法: bash scripts/verify-deploy.sh [BOT_DIR]
#   BOT_DIR 默认 /opt/qq-farm-bot-3010
# 退出码 0=全绿, 1=有问题
# ============================================================
set -u
BOT_DIR="${1:-/opt/qq-farm-bot-3010}"
DIST="$BOT_DIR/core/dist"
fail=0

echo "========== QQ Farm Bot 部署校验 =========="
echo "目标目录: $BOT_DIR"
echo

# ---- 1. 定制标记检查（核心！少一个=定制被冲掉）----
echo "【1/4】定制功能标记（必须在 core/dist 中齐全）"
declare -A MARKS=(
  ["YYB微信换码"]="runtime/worker-manager.js:refreshYybCodeIfNeeded"
  ["NapCat换码"]="runtime/worker-manager.js:refreshNapcatCodeIfNeeded"
  ["自动刷新Code"]="runtime/runtime-engine.js:auto-code-refresh"
  ["YYB路由"]="controllers/admin/index.js:mountYybWxRoutes"
  ["NapCat路由"]="controllers/admin/index.js:mountNapCatRoutes"
  ["账号yybOpenid"]="models/store/accounts.js:yybOpenid"
  ["GID手动锁"]="services/friend/gid-manager.js:getKnownFriendGidsManualLock"
  ["上游推送Meow"]="services/push.js:meow"
  ["小红花进度奖励"]="runtime/data-provider.js:claimCharityRedFlowerProgressReward"
  ["小红花常量"]="services/activity-center.js:CHARITY_FLOW_DAILY_GIFT_CLAIMED"
)
for name in "${!MARKS[@]}"; do
  rel="${MARKS[$name]%%:*}"; kw="${MARKS[$name]##*:}"; f="$DIST/$rel"
  if [ -f "$f" ] && grep -q "$kw" "$f"; then
    printf "  ✅ %-16s %s\n" "$name" "$rel"
  else
    printf "  ❌ %-16s %s  (缺失标记: %s)\n" "$name" "$rel" "$kw"
    fail=1
  fi
done
echo

# ---- 2. proto 实加载（确认新类型能 lookup）----
echo "【2/4】Protobuf 实加载验证"
if [ -f "$DIST/utils/proto.js" ]; then
  out=$(cd "$BOT_DIR/core" && node -e "
    const m=require('./dist/utils/proto.js');
    (async()=>{ await m.loadProto();
      const need=['CharityRedFlowerProgressRewardResult','CharityRedFlowerOperateRequest'];
      let bad=need.filter(n=>!m.types[n]);
      console.log(bad.length? 'MISSING:'+bad.join(','):'OK');
    })().catch(e=>{console.log('ERR:'+e.message);process.exit(2);});
  " 2>&1)
  if echo "$out" | grep -q '^OK'; then echo "  ✅ proto 类型齐全"; else echo "  ❌ proto: $out"; fail=1; fi
else
  echo "  ⚠️  跳过（无 proto.js）"; fi
echo

# ---- 3. 服务状态 ----
echo "【3/4】服务状态"
for s in qq-farm-bot-3010 gid-tool-web napcat-code-web qq-farm-download yyb-go; do
  st=$(systemctl is-active "$s" 2>/dev/null)
  if [ "$st" = "active" ]; then printf "  ✅ %-20s active\n" "$s"; else printf "  ❌ %-20s %s\n" "$s" "$st"; fail=1; fi
done
echo

# ---- 4. 近期错误 ----
echo "【4/4】近 10 分钟错误扫描"
err=$(journalctl -u qq-farm-bot-3010 --since '-10min' --no-pager 2>/dev/null | grep -c 'no such type\|进程报错\|\[error\]')
if [ "$err" -eq 0 ]; then echo "  ✅ bot 近 10 分钟 0 错误"; else echo "  ❌ bot 近 10 分钟 $err 处错误"; fail=1; fi
echo

if [ "$fail" -eq 0 ]; then
  echo "========== 结论: 全绿 ✅ 可以放心 =========="
  exit 0
else
  echo "========== 结论: 有问题 ❌ 见上方 ❌ 项 =========="
  exit 1
fi
