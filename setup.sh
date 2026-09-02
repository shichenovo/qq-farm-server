#!/usr/bin/env bash
# ============================================================
# setup.sh — QQ Farm Bot 一键部署（Ubuntu/Debian, linux/amd64, root）
# 用法: sudo bash setup.sh
# 交互式填写 YYB token 等敏感项；其余按仓库默认值铺设。
# 注意: NapCat(QQ 登录) 容器见下方「NapCat 容器」段落，需另行准备镜像。
# ============================================================
set -euo pipefail
R="\033[31m"; G="\033[32m"; Y="\033[33m"; N="\033[0m"
info(){ echo -e "${G}[info]${N} $*"; }
warn(){ echo -e "${Y}[warn]${N} $*"; }
err(){ echo -e "${R}[error]${N} $*"; }

# ---- 目录布局（全部落在 /opt，与 systemd 单元一致）----
BOT=/opt/qq-farm-bot-3010
GID=/opt/gid-tool-web
NAP=/opt/napcat-code-web
YYB=/opt/yyb-go
DL=/opt/downloads
REPO="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = "0" ] || { err "请用 root 运行: sudo bash setup.sh"; exit 1; }

info "1/7 安装系统依赖 (node, npm, docker, python3, git)..."
apt-get update -y >/dev/null 2>&1
apt-get install -y -q nodejs npm git python3 curl >/dev/null 2>&1 || true
if ! command -v docker >/dev/null; then
  warn "未检测到 docker，正在安装..."
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || warn "docker 安装失败，请手动安装"
fi
command -v node && node -v

info "2/7 铺设各服务目录..."
mkdir -p "$BOT" "$GID" "$NAP" "$YYB" "$DL" /opt/upstream-ref
cp -r "$REPO/qq-farm-bot-3010/." "$BOT/"
cp -r "$REPO/gid-tool-web/." "$GID/"
cp -r "$REPO/napcat-code-web/." "$NAP/"
cp -r "$REPO/yyb-go/." "$YYB/"
cp -r "$REPO/downloads/." "$DL/" 2>/dev/null || true

info "3/7 安装 node 依赖..."
( cd "$BOT/core" && npm install --omit=dev >/dev/null 2>&1 && info "  bot core 依赖 OK" ) || warn "bot core npm install 失败"
( cd "$GID" && npm install --omit=dev >/dev/null 2>&1 && info "  gid-tool 依赖 OK" ) || warn "gid npm install 失败"
( cd "$NAP" && npm install --omit=dev >/dev/null 2>&1 && info "  napcat-code-web 依赖 OK" ) || warn "napcat npm install 失败"

info "4/7 生成 .env (敏感项请按提示填写)..."
if [ ! -f "$BOT/.env" ]; then
  cp "$REPO/.env.example" "$BOT/.env"
  read -r -p "  输入 YYB_API_TOKEN (应用宝换码, 微信账号必需): " YYBTOK
  sed -i "s#REPLACE_WITH_YOUR_YYB_TOKEN#${YYBTOK}#" "$BOT/.env"
  # 把 token 也写进 yyb-go 与 keepalive 需要的环境（由 systemd 注入，这里仅提醒）
  info "  .env 已生成 (面板账号/密码 默认 admin/admin)"
else
  warn "  $BOT/.env 已存在，跳过"
fi

info "5/7 生成 accounts.json (从模板，请随后在面板里添加账号)..."
if [ ! -f "$BOT/core/data/accounts.json" ]; then
  mkdir -p "$BOT/core/data"
  cp "$REPO/accounts.example.json" "$BOT/core/data/accounts.json"
  info "  已生成空模板，登录面板后添加你的 QQ/微信账号"
fi

info "6/7 安装 systemd 单元..."
for u in qq-farm-bot-3010 gid-tool-web napcat-code-web qq-farm-download yyb-go yyb-keepalive; do
  if [ -f "$REPO/systemd/$u.service" ]; then
    cp "$REPO/systemd/$u.service" /etc/systemd/system/
  fi
done
[ -f "$REPO/systemd/yyb-keepalive.timer" ] && cp "$REPO/systemd/yyb-keepalive.timer" /etc/systemd/system/
# 把 YYB token 注入到 yyb 相关 unit（避免明文写在仓库里）
if [ -n "${YYBTOK:-}" ]; then
  sed -i "s#REPLACE_WITH_YOUR_YYB_TOKEN#${YYBTOK}#" /etc/systemd/system/yyb-go.service
  sed -i "s#REPLACE_WITH_YOUR_YYB_TOKEN#${YYBTOK}#" /etc/systemd/system/qq-farm-bot-3010.service
  sed -i "s#REPLACE_WITH_YOUR_YYB_TOKEN#${YYBTOK}#" /etc/systemd/system/gid-tool-web.service
fi
systemctl daemon-reload
for u in qq-farm-bot-3010 gid-tool-web napcat-code-web qq-farm-download yyb-go yyb-keepalive.timer; do
  systemctl enable "$u" >/dev/null 2>&1 || true
done
info "  systemd 单元已安装并设为开机自启"

info "7/7 NapCat 容器（QQ 登录必需，需另行准备镜像）..."
if docker image inspect qq-farm-napcat:farm >/dev/null 2>&1; then
  info "  检测到镜像 qq-farm-napcat:farm，启动容器..."
  docker rm -f napcat-farm 2>/dev/null || true
  docker run -d --name napcat-farm --restart unless-stopped \
    -p 6099:6099 -p 9700:9700 \
    -v qq-farm-napcat-data:/app/napcat-data \
    -v /run/qqfarm-napcat-bridge:/run/qqfarm-napcat-bridge \
    qq-farm-napcat:farm
  systemctl start qq-farm-bot-3010 gid-tool-web napcat-code-web qq-farm-download yyb-go yyb-keepalive.timer
  info "  全部启动，跑 bash $REPO/scripts/verify-deploy.sh 验收"
else
  warn "未找到镜像 qq-farm-napcat:farm。"
  warn "请见 README『NapCat 容器』段落：docker build -f docker/Dockerfile . -t qq-farm-napcat:farm"
  warn "或把已有镜像 docker save/load 到本机。然后重跑: bash setup.sh"
  warn "（bot/微信(gid/napcat-code/yyb) 已就绪，仅 QQ 登录需该容器）"
fi

info "部署脚本结束。面板: http://<本机IP>:3010  账号 admin / 密码 admin"
