# QQ Farm NapCat 镜像
# ============================================================================
# ⚠️ 重要：本镜像无法“凭空”构建出能跑的 QQ 登录容器。
#   生产镜像依赖两类仓库里放不下的东西：
#   1) 官方 QQ for Linux 完整发行目录（/opt/QQ，约 204MB 二进制+资源），
#      受版权/体积限制不能进 git 仓库，需自行下载后放入构建上下文 ./qq-linux/；
#   2) 下方 COPY 的 NapCat 装载代码（已补齐在 docker/napcat-loader/）。
#   若你没有 QQ 二进制，请勿用本 Dockerfile 构建 —— 直接走 README 的
#   「方案B：docker save/load 现有镜像」即可（当前生产机 103.117.137.115
#   上的 qq-farm-napcat:farm 就是可用镜像）。
#
# 构建（需先准备好 ./qq-linux/ 目录，内含官方 QQ for Linux 的 /opt/QQ 内容）:
#   docker build -f docker/Dockerfile . -t qq-farm-napcat:farm
# 运行见 docker-compose.yml 或 README。
# ============================================================================

FROM node:20-bookworm

# 浏览器/Electron 运行依赖
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb libnss3 libnspr4 libgbm1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
      libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgtk-3-0 libnotify4 libsecret-1-0 \
      libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
      libx11-xcb1 fonts-wqy-zenhei tini procps tzdata; \
    apt-get purge -y --auto-remove; rm -rf /var/lib/apt/lists/*

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    DISPLAY=:1 \
    NAPCAT_WORKDIR=/app/napcat-data \
    NAPCAT_LAUNCH_MODE=process \
    NAPCAT_BRIDGE_HTTP_PORT=9700 \
    NAPCAT_BRIDGE_SOCKET=/run/qqfarm-napcat-bridge/bridge.sock

WORKDIR /app

# ---- 本项目自带文件 ----
COPY docker/napcat-bridge/ /app/napcat-bridge/
COPY docker/napcat-loader/ /app/napcat/
COPY docker/napcat-defaults/ /app/napcat-defaults/
COPY docker/napcat-entrypoint.sh /usr/local/bin/napcat-entrypoint.sh
COPY qq-farm-bot-3010/custom-modules/services/napcat-openauth.js /app/core/src/services/napcat-openauth.js

# NapCat 装载代码依赖安装（容器内 npm install，node_modules 不进仓库）
RUN cd /app/napcat && (npm install --omit=dev >/dev/null 2>&1 || true)

# ---- 官方 QQ for Linux 二进制（必需，自备，不进仓库）----
# 把官方 QQ for Linux 的完整安装目录（含 qq 二进制、resources/、chrome-sandbox 等）
# 放到构建上下文的 ./qq-linux/ 下，再构建。缺少它镜像虽能构建但 QQ 无法启动。
COPY docker/qq-linux-placeholder /opt/QQ

RUN chmod +x /usr/local/bin/napcat-entrypoint.sh /app/napcat/launch-qq.sh

EXPOSE 6099 9700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({socketPath:process.env.NAPCAT_BRIDGE_SOCKET,path:'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--"]
CMD ["/usr/local/bin/napcat-entrypoint.sh"]
