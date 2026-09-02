# Docker 全栈部署指南

把整个 QQ Farm 服务端（含面板、GID 工具、扫码取码、下载、YYB 换码、保活）用 Docker Compose 一键拉起，**不再依赖 systemd、不再需要手动 npm install、不再区分发行版**（只要能跑 Docker 的 Linux x86-64 即可）。

> 架构前提：所有服务均为 **amd64**。ARM 服务器（树莓派 / Apple Silicon）目前跑不了 `yyb-go` 预编译二进制与 QQ 登录镜像，需自行重新编译。

## 目录结构

```
docker/
├── docker-compose.yml      # 全栈编排(6 服务 + napcat-farm profile)
├── .env.example            # 部署配置样例(复制为 .env)
├── Dockerfile.bot          # QQ Farm Bot 主程序
├── Dockerfile.gid          # GID 好友工具
├── Dockerfile.napcat-code  # 扫码取码网页
├── Dockerfile.yyb          # YYB Go 换码
├── Dockerfile.keepalive    # YYB 保活循环
├── Dockerfile.download     # 静态下载
└── Dockerfile             # NapCat 镜像(需自备 QQ 二进制)
```

## 一、准备

```bash
cd docker
cp .env.example .env
# 编辑 .env，至少填 YYB_API_TOKEN
vim .env
```

`.env` 关键项：

| 变量 | 说明 | 默认 |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | 面板账号 | `admin` / `admin` |
| `TZ` | 时区 | `Asia/Shanghai` |
| `YYB_API_TOKEN` | 应用宝换码 token，**必填**（微信账号登录用） | 无 |
| `NAPCAT_CODE_WEB_PASSWORD` | 8088 扫码页密码 | `q20947154` |
| `WX_OPENID` | 微信账号 openid（保活用，可选） | 无 |

## 二、启动（不含 QQ 登录）

```bash
docker compose up -d
```

这会拉起 6 个服务：`qq-farm-bot`(3010) / `gid-tool-web`(8099) / `napcat-code-web`(8088) / `qq-farm-download`(8080) / `yyb-go`(8450) / `yyb-keepalive`。

## 三、QQ 登录容器（napcat-farm）

镜像 `qq-farm-napcat:farm` **无法从本仓库构建**（内含 204MB 官方 QQ for Linux 二进制，不进 git）。二选一获取：

**A. 从已有服务器导出（推荐，最稳）**
```bash
# 在已有服务器(如 103.117.137.115)上:
docker save qq-farm-napcat:farm -o napcat-farm.tar
# 拷贝到新服务器后:
docker load -i napcat-farm.tar
```

**B. 自备 QQ 二进制后构建**
```bash
# 把官方 QQ for Linux 放到 docker/qq-linux（或按 docker/Dockerfile 注释准备）
docker compose build napcat-farm   # 见 docker/Dockerfile 说明
```

启用 QQ 登录容器：
```bash
docker compose --profile qq-login up -d
```

## 四、验证

```bash
# 端口
curl -s -o /dev/null -w "bot 3010: %{http_code}\n" http://127.0.0.1:3010/
curl -s -o /dev/null -w "gid 8099: %{http_code}\n" http://127.0.0.1:8099/
curl -s -o /dev/null -w "napcat-code 无密码: %{http_code}\n" http://127.0.0.1:8088/
curl -s -o /dev/null -w "napcat-code 带密码: %{http_code}\n" "http://127.0.0.1:8088/?pwd=q20947154"
curl -s -o /dev/null -w "yyb 8450: %{http_code}\n" http://127.0.0.1:8450/
```

面板访问：http://服务器IP:3010/ ，账号 `admin` / `admin`（请尽快改密码）。

## 五、数据持久化

- `qqfarm-data` 卷：`/app/core/data`，含 `accounts.json` 与日志。
- `qq-farm-napcat-data` 卷：NapCat 登录态。
- `bridge-socket` 卷：QQ 登录桥接 unix socket，被 4 个服务共享。

## 六、与 systemd 部署的差异

| 项 | systemd 部署 | Docker 部署 |
|---|---|---|
| 依赖 | 需 Node/Python/Go + 手动 npm install | 仅需 Docker |
| 跨发行版 | 仅 Debian 系 | 任意能跑 Docker 的 Linux x86-64 |
| 进程管理 | systemd unit + timer | compose restart 策略 |
| 服务互访 | 127.0.0.1 | compose 服务名（如 `http://yyb-go:8450`） |
| YYB 端口 | 二进制默认 8000，systemd 传 `-port 8450` | 镜像内已写死 `-port 8450` |
| 保活 | systemd timer 30min | keepalive 容器循环 30min |

两种部署路径在仓库中并存：`setup.sh` 走 systemd，`docker/` 走 compose，按需选用。
