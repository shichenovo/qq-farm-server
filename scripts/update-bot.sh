#!/usr/bin/env bash
# ============================================================
# update-bot.sh — 在【沙箱】里安全合并上游更新（不碰生产机）
# 用法:
#   bash scripts/update-bot.sh <UPSTREAM_URL> <BASE_COMMIT> <LATEST_COMMIT> <PROD_BOT_DIR>
#
# 例:
#   bash scripts/update-bot.sh \
#     https://github.com/liyangpengs/qq-farm-bot \
#     b48a6d7 19de58e /opt/qq-farm-bot-3010
#
# 做什么:
#   1. 克隆上游, 在沙箱构建 BASE 与 LATEST 两个 dist
#   2. git diff --name-status 列出【全部】变更(含 proto/web/package.json)
#   3. 对每个上游改动且生产也改过的 core/dist/*.js 做 3-way merge
#   4. 列出 proto / web / package.json 让你单独处理(见 UPDATE-GUIDE.md)
#   5. 不自动覆盖生产! 只把合并结果放到 ./update-out/, 由你 Review 后上传
#
# 前置: node, pnpm, git
# ============================================================
set -euo pipefail
UPSTREAM_URL="${1:?用法: update-bot.sh <url> <base> <latest> <prod_dir>}"
BASE="${2:?缺少 BASE_COMMIT}"
LATEST="${3:?缺少 LATEST_COMMIT}"
PROD="${4:?缺少生产 bot 目录(本机路径)}"
WORK=/tmp/upstream-merge
OUT="$PWD/update-out"

echo "==> 清理并克隆上游"
rm -rf "$WORK"; git clone "$UPSTREAM_URL" "$WORK" --quiet
cd "$WORK"

echo "==> 构建 BASE ($BASE) dist"
git checkout "$BASE" --quiet
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1
pnpm build:ts >/dev/null 2>&1
mkdir -p /tmp/base-dist && cp -r core/dist /tmp/base-dist/dist

echo "==> 构建 LATEST ($LATEST) dist"
git checkout "$LATEST" --quiet
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1
pnpm build:ts >/dev/null 2>&1
mkdir -p /tmp/up-dist && cp -r core/dist /tmp/up-dist/dist

echo "==> 全部变更文件(BASE -> LATEST), 含 proto/web/package.json:"
git diff --name-status "$BASE" "$LATEST" | tee "$OUT.changed.txt"

echo
echo "==> 对 core/dist 中上游改动且生产也改过的 .js 做 3-way merge"
mkdir -p "$OUT"
# 计算上游在 core/dist 中变更的 js
up_changed=$(cd /tmp/up-dist/dist && find . -name '*.js' | sed 's#^\./##')
for f in $up_changed; do
  prod_f="$PROD/core/dist/$f"
  base_f="/tmp/base-dist/dist/$f"
  latest_f="/tmp/up-dist/dist/$f"
  [ -f "$prod_f" ] || continue          # 上游有、生产没有 → 直接采用(纯上游新增)
  [ -f "$base_f" ] || continue
  [ -f "$latest_f" ] || continue
  merged=$(git merge-file -p "$prod_f" "$base_f" "$latest_f" 2>/dev/null) || true
  if echo "$merged" | grep -q '^<<<<<<<\|^>>>>>>>'; then
    printf '  ⚠️  冲突: %s (已生成 %s, 需人工解决)\n' "$f" "$OUT/$f"
    mkdir -p "$(dirname "$OUT/$f")"; echo "$merged" > "$OUT/$f"
  else
    mkdir -p "$(dirname "$OUT/$f")"; echo "$merged" > "$OUT/$f"
    printf '  ✅ 合并: %s\n' "$f"
  fi
done

echo
echo "==> 结果在: $OUT  (Review 后 scp 到生产对应路径, 再跑 verify-deploy.sh)"
echo "==> 别忘了单独处理: proto 定义(直接覆盖), web 前端(沙箱重建), package.json 版本号"
