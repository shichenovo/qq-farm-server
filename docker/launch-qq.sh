#!/bin/bash
# 容器内启动 QQ(NapCat) 临时授权会话。
# 对应宿主机旧脚本 start-napcat-xvfb.sh，区别：
#   - Xvfb 由 entrypoint 常驻，这里不再 xvfb-run
#   - 路径指向容器内 /opt/QQ 与 /app/napcat
#   - 由 bridge 以子进程方式拉起并写 PID，不依赖 systemd
set -euo pipefail

NAPCAT_WORKDIR="${NAPCAT_WORKDIR:-/app/napcat-data}"
QQ_DIR=/opt/QQ
APP_DIR="$QQ_DIR/resources/app"

# 临时授权器的 QQ 登录数据与宿主隔离，每次授权后由 bridge 清理，
# 因此新账号总是从二维码开始。
export HOME="$NAPCAT_WORKDIR/session-home"
mkdir -p "$HOME/.config/QQ/versions"

export NAPCAT_WRAPPER_PATH="$APP_DIR/wrapper.node"
export NAPCAT_QQ_PACKAGE_INFO_PATH="$APP_DIR/package.json"
export NAPCAT_QQ_VERSION_CONFIG_PATH="$NAPCAT_WORKDIR/qq-version-config.json"
export NAPCAT_WORKDIR
export NAPCAT_WEBUI_PREFERRED_PORT="${NAPCAT_WEBUI_PREFERRED_PORT:-6099}"
export NAPCAT_LOAD_PATH=/app/napcat/loadNapCat.js

QQ_VERSION="$(node -e 'const p=require("/opt/QQ/resources/app/package.json");process.stdout.write(String(p.linuxVersion||p.version||""))')"
QQ_BUILD="${QQ_VERSION##*-}"
QQ_BASE="${QQ_VERSION%%-*}"
cat > "$NAPCAT_QQ_VERSION_CONFIG_PATH" <<CONFIG
{"baseVersion":"$QQ_BASE.$QQ_BUILD","curVersion":"$QQ_VERSION","buildId":"$QQ_BUILD","onErrorVersions":[]}
CONFIG
cp "$NAPCAT_QQ_VERSION_CONFIG_PATH" "$HOME/.config/QQ/versions/config.json"

# QQ 首启时会把 major.node（104MB）解包到用户数据目录的 versions/<版本>/ 下，
# 之后靠它做 preload 加载 NapCat。而授权结束后 bridge 会把 session-home 整个删掉
# （见 napcat-openauth.js 的 stopTemporaryNapCat），于是从快速登录资料恢复出来的
# 目录里只剩 versions/config.json、没有 major.node。
# 缺了它 QQ 会打一行 "[preload] failed ... major.node: No such file"，
# NapCat 加载不起来，快速登录 (-q) 必然退回二维码登录 ——
# 表现就是「无人值守刷新 Code 永远失败」，且不报任何业务错误，极难定位。
# 所以每次启动前按需补齐（已存在就不动，避免每轮白拷 104MB）。
VER_DIR="$HOME/.config/QQ/versions/$QQ_VERSION"
mkdir -p "$VER_DIR"
if [ ! -s "$VER_DIR/major.node" ]; then
  cp -f "$APP_DIR/major.node" "$VER_DIR/major.node"
fi

# 优先使用 QQ 自带原生库：libgnutls 修 libbugly 的 gnutls_free，
# 自带 libvips 修 sharp 的 vips_g_once。
BUNDLED_VIPS="$APP_DIR/sharp-lib/libvips-cpp.so.42"
SYSTEM_GNUTLS="/usr/lib/x86_64-linux-gnu/libgnutls.so.30"
export LD_LIBRARY_PATH="$APP_DIR/sharp-lib:$APP_DIR:$QQ_DIR:${LD_LIBRARY_PATH:-}"
if [ -f "$SYSTEM_GNUTLS" ] && [ -f "$BUNDLED_VIPS" ]; then
  export LD_PRELOAD="$SYSTEM_GNUTLS:$BUNDLED_VIPS${LD_PRELOAD:+:$LD_PRELOAD}"
elif [ -f "$BUNDLED_VIPS" ]; then
  export LD_PRELOAD="$BUNDLED_VIPS${LD_PRELOAD:+:$LD_PRELOAD}"
fi

cd "$QQ_DIR"
exec "$QQ_DIR/qq" \
  --no-sandbox \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-software-rasterizer \
  --in-process-gpu \
  --disable-dev-shm-usage \
  --use-gl=swiftshader \
  "$@"
