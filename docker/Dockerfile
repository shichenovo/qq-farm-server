# QQ Farm NapCat 镜像 —— 在官方 NapCat 基础上叠加本项目的自定义桥接/鉴权
# 说明：本镜像需要 NapCat 本体（含 /opt/QQ 二进制）。官方镜像会自行下载 QQ 二进制，
#      所以基于官方 napcat 镜像构建即可；若你的环境无法拉取官方镜像，请自备构建上下文。
#
# 构建:  docker build -f docker/Dockerfile . -t qq-farm-napcat:farm
# 运行见 docker-compose.yml 或 README。

FROM node:20-bookworm

# 安装 NapCat（OneBot 实现）与浏览器依赖
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb libnss3 libnspr4 libgbm1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
      libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgtk-3-0 libnotify4 libsecret-1-0 \
      libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
      libx11-xcb1 fonts-wqy-zenhei tini procps tzdata; \
    npm install -g @napcat/cli >/dev/null 2>&1 || true; \
    apt-get purge -y --auto-remove; rm -rf /var/lib/apt/lists/*

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    DISPLAY=:1 \
    NAPCAT_WORKDIR=/app/napcat-data \
    NAPCAT_LAUNCH_MODE=process \
    NAPCAT_BRIDGE_HTTP_PORT=9700 \
    NAPCAT_BRIDGE_SOCKET=/run/qqfarm-napcat-bridge/bridge.sock

WORKDIR /app

# 我们的自定义文件
COPY docker/napcat-bridge/ /app/napcat-bridge/
COPY docker/napcat-entrypoint.sh /usr/local/bin/napcat-entrypoint.sh
COPY docker/launch-qq.sh /app/napcat/launch-qq.sh
COPY qq-farm-bot-3010/custom-modules/services/napcat-openauth.js /app/core/src/services/napcat-openauth.js

RUN chmod +x /usr/local/bin/napcat-entrypoint.sh /app/napcat/launch-qq.sh

EXPOSE 6099 9700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({socketPath:process.env.NAPCAT_BRIDGE_SOCKET,path:'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--"]
CMD ["/usr/local/bin/napcat-entrypoint.sh"]
