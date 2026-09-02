#!/bin/bash
# napcat-farm 容器入口：Xvfb + bridge。
#
# 两种运行模式：
#   NAPCAT_KEEP_SESSION = 1（默认）：QQ 登录一次后长期在线，崩了自动拉起。
#     刷新 Code 直接在在线会话上调 OpenAuth，秒级完成，不再依赖冷启动快速登录。
#   NAPCAT_KEEP_SESSION = 0：QQ 由 bridge 按需拉起/回收。省内存、支持多账号串行，
#     但每次刷新 Code 都要冷启动一个 QQ 并赌快速登录能成功（见下方常驻模式的说明）。
#
# 默认值必须与 core/src/services/napcat-openauth.js 里的 NAPCAT_KEEP_SESSION 保持一致。
# 两边一旦不一致就会出现这样的死局：core 认为常驻、授权后不清登录态，
# 容器这边却根本不拉起 QQ，于是刷新永远等不到一个在线会话。
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/app/napcat-home}"
NAPCAT_WORKDIR="${NAPCAT_WORKDIR:-/app/napcat-data}"
export NAPCAT_WORKDIR
# 标准镜像由 Dockerfile 的 ENV 提供 launcher 路径；换镜像或 docker run 漏传时兜底。
# 不做兜底的话常驻循环会对着一个不存在的路径反复启动，日志里刷满 command not found，
# 而 QQ 始终起不来 —— 面板上的表现只是「扫码没反应」。
export NAPCAT_LAUNCHER="${NAPCAT_LAUNCHER:-/app/napcat/launch-qq.sh}"

mkdir -p \
  "$HOME/.config/QQ/versions" \
  "$NAPCAT_WORKDIR/config" \
  "$NAPCAT_WORKDIR/cache" \
  "$NAPCAT_WORKDIR/logs" \
  "$NAPCAT_WORKDIR/quick-login-profiles" \
  "$NAPCAT_WORKDIR/session-home"

# 首次启动播种默认配置（已存在的不覆盖，保留扫码后的登录态与 token）
for f in /app/napcat-defaults/config/*; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  [ -e "$NAPCAT_WORKDIR/config/$base" ] || cp -a "$f" "$NAPCAT_WORKDIR/config/$base"
done

# Xvfb：QQ 是 Electron 应用，无 X 显示会直接退出
Xvfb "$DISPLAY" -screen 0 1080x760x16 +extension GLX +render -nolisten tcp > /dev/null 2>&1 &
XVFB_PID=$!

for _ in $(seq 1 40); do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.25
done

# 常驻模式：容器一进来就把 QQ 拉起来，并持续保活。
# 冷启动快速登录那条路太脆了——只要用户数据目录里缺了 versions/<版本>/major.node，
# QQ 就打一行 [preload] failed 然后退回二维码，无人值守刷新必挂。
# 保持在线可以彻底绕开它：刷新 Code 时会话已经在，直接调 OpenAuth 就行。
keep_session() {
  case "$(printf '%s' "${NAPCAT_KEEP_SESSION:-1}" | tr '[:upper:]' '[:lower:]' | tr -d ' ')" in
    0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

last_saved_uin() {
  # 末尾 return 0 是必须的：首次部署时这个目录是空的，grep 匹配不到会返回 1，
  # 而调用处 `UIN="$(last_saved_uin)"` 的退出码就是命令替换的退出码。
  # 在 set -e 下那一行会直接把保活 subshell 干掉 —— 表现为「容器起来了但 QQ 永远不启动」，
  # 且日志里一行报错都没有。老版本默认关闭常驻，这段代码从没被执行过，所以一直没暴露。
  ls "$NAPCAT_WORKDIR/quick-login-profiles" 2>/dev/null | grep -E '^[0-9]{5,20}$' | head -1
  return 0
}

if keep_session; then
  (
    while true; do
      if [ ! -x "$NAPCAT_LAUNCHER" ]; then
        echo "[entrypoint] NAPCAT_LAUNCHER 不存在或不可执行：$NAPCAT_LAUNCHER，停止保活" >&2
        break
      fi
      if ! pgrep -x qq > /dev/null 2>&1; then
        UIN="$(last_saved_uin || true)"
        # 有存档就带 -q 走快速登录；没有就裸启动，等用户在面板上扫码。
        if [ -n "$UIN" ]; then
          NAPCAT_WORKDIR="$NAPCAT_WORKDIR" setsid "$NAPCAT_LAUNCHER" -q "$UIN" \
            >> "$NAPCAT_WORKDIR/logs/napcat-launcher.log" 2>&1 &
        else
          NAPCAT_WORKDIR="$NAPCAT_WORKDIR" setsid "$NAPCAT_LAUNCHER" \
            >> "$NAPCAT_WORKDIR/logs/napcat-launcher.log" 2>&1 &
        fi
      fi
      sleep 20
    done
  ) &
  KEEPALIVE_PID=$!
fi

shutdown() {
  kill "${BRIDGE_PID:-}" 2>/dev/null || true
  kill "${KEEPALIVE_PID:-}" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

node /app/napcat-bridge/server.js &
BRIDGE_PID=$!
wait "$BRIDGE_PID"
