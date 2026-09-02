# QQ Farm Bot 一键部署仓库

本仓库是从一台**正在运行的 QQ 农场Bot服务器**导出的完整可部署快照，包含：

- 🤖 农场 Bot 本体（`qq-farm-bot-3010`，已合并上游 `liyangpengs/qq-farm-bot` 20260902 更新）
- 🌐 前端面板（含**公益小红花 UI** + **金币按单位(万/亿)显示**定制）
- 🔧 4 个配套服务：好友 GID 提取(8099) / NapCat 扫码取码(8088) / 下载(8080) / 应用宝微信换码(8450)
- 🐳 NapCat(QQ 登录) 容器构建文件
- 📋 systemd 单元、`.env.example`、账号模板、一键 `setup.sh`
- 📘 **给 AI/维护者的升级 SOP**：[docs/UPDATE-GUIDE.md](docs/UPDATE-GUIDE.md)

> ⚠️ **所有密钥均已脱敏**：仓库里只有占位符（`REPLACE_WITH_YOUR_*`），真实 token / 账号 / 密码**不在**本仓库。

---

## 架构一览

```
                        ┌─────────────────────────────┐
   浏览器/手机 ───────▶ │  前端面板  :3010 (admin/admin) │
                        └──────────────┬──────────────┘
                                       │
                        ┌──────────────▼──────────────┐
                        │  qq-farm-bot-3010 (core/dist) │◀── 自动挂机/换码
                        └───┬──────────┬──────────┬─────┘
             NapCat 桥     │          │          │  YYB API
              :9700       │          │          │
        ┌─────────────────▼──┐  ┌─────▼────────┐  ┌▼──────────────┐
        │ napcat 容器(farm)  │  │gid-tool 8099│  │ yyb-go 8450   │
        │ bridge.sock       │  │            │  │ 微信换码       │
        └─────────┬─────────┘  └─────┬────────┘  └───────────────┘
                  │ 8088 扫码页         │ 取好友GID
          ┌───────▼────────┐   ┌───────▼────────┐
          │napcat-code-web │   │  (同上 3010)   │
          └────────────────┘   └────────────────┘

  qq-farm-download :8080  = 静态文件下载服务
  yyb-keepalive.timer     = 每 30 分钟微信 login_buffer 保活
```

**关键事实**：Bot 运行时只加载 `qq-farm-bot-3010/core/dist/*`。`custom-modules/` 只是它的镜像（不参与加载）。
升级 / 改逻辑请改 `core/dist/*`，详见 [UPDATE-GUIDE.md](docs/UPDATE-GUIDE.md)。

---

## 快速部署（Ubuntu / Debian, linux/amd64, root）

```bash
git clone <本仓库> qq-farm && cd qq-farm
sudo bash setup.sh
# 按提示输入 YYB_API_TOKEN（微信账号必需）
# 脚本会: 装依赖 → 铺目录 → 生成 .env/accounts → 装 systemd → 启服务
```

部署完打开 `http://<服务器IP>:3010`，**账号 `admin` / 密码 `admin`**，进去添加你的 QQ / 微信账号。

然后跑校验：
```bash
bash scripts/verify-deploy.sh
```

---

## NapCat 容器（QQ 登录必需）

QQ 登录走 NapCat 容器，它提供 `bridge.sock` 给 Bot / 8088 / gid 工具通信。
本仓库**不含可一键拉取的镜像**（镜像是本地基于官方 NapCat + 自定义桥接构建的，体积 1.3GB）。
两种准备方式：

> ⚠️ **实测结论（2026-09-03）**：仓库里的 Dockerfile **不能凭空产出可运行的 QQ 登录镜像**。
> 原因是生产镜像依赖两样无法进 git 的东西：(1) 官方 QQ for Linux 完整发行目录
> `/opt/QQ`（约 204MB 二进制+资源）；(2) NapCat 装载代码（现已补齐在 `docker/napcat-loader/`）。
> 因此**方案 A 仅在你自备 QQ 二进制时才可行**；对绝大多数“任意服务器”场景，
> **请直接用方案 B 搬运现有镜像**，这是唯一经实测验证可行的 QQ 登录部署路径。

**方式 A — 用本仓库 Dockerfile 自行构建（需自备 QQ 二进制）**
```bash
# 1) 下载官方 QQ for Linux，把其完整安装目录放到构建上下文 ./docker/qq-linux/
#    （内含 qq 二进制、resources/、chrome-sandbox 等，对应生产镜像的 /opt/QQ）
# 2) 构建并启动
docker build -f docker/Dockerfile . -t qq-farm-napcat:farm
docker compose -f docker/docker-compose.yml up -d
```
> 构建基于 `node:20-bookworm` + 本项目 `docker/napcat-bridge` 桥接 + `docker/napcat-loader` 装载代码。
> **缺少 `./docker/qq-linux/` 时镜像虽能构建，但 QQ 无法启动**（这是预期行为，不是 bug）。

**方式 B — 从已有服务器导出镜像（推荐，实测可行）**
```bash
# 在旧服务器(103.117.137.115)上:
docker save qq-farm-napcat:farm -o napcat-farm.tar
# 在新服务器上:
docker load -i napcat-farm.tar
docker compose -f docker/docker-compose.yml up -d
```

容器起来后，在 8088 扫码页用密码（默认 `q20947154`，**请改成你自己的**）登录取 Code，
Bot 会自动用 Code 刷新 QQ 会话。

---

## 安全提醒（部署后必做）

| 项 | 默认 | 建议 |
|---|---|---|
| 面板账号/密码 | `admin` / `admin` | **立即改成强密码**（改 `qq-farm-bot-3010/.env` 的 `ADMIN_PASSWORD`） |
| 8088 扫码页密码 | `q20947154` | 改成你自己的（改 `systemd/napcat-code-web.service` 的 `NAPCAT_CODE_WEB_PASSWORD`） |
| 8088 / 8080 绑定 | `0.0.0.0` 公网 | 建议用防火墙/反代限制来源 IP，或改绑 `127.0.0.1` + 隧道 |
| YYB token | 你填的 | 仅本机使用，勿泄露 |

> 历史上曾有陌生人通过公网暴露的 8088 扫码页扫了自己的 QQ —— 设强密码 + 限制来源 IP 可杜绝。

---

## 目录结构

```
qq-farm-server/
├── qq-farm-bot-3010/      # Bot 本体（core/dist 运行时真源 + core/src 资源 + web/dist 前端 + custom-modules 镜像）
├── gid-tool-web/           # 好友 GID 提取 (8099)
├── napcat-code-web/        # NapCat 扫码取 Code 网页 (8088, 需密码)
├── yyb-go/                 # 应用宝(微信)换码服务 (8450) + keepalive 脚本
├── downloads/              # 下载服务根目录 (8080, 占位)
├── systemd/                # 7 个 unit 文件（token 已脱敏为占位符）
├── docker/                 # NapCat 容器 Dockerfile / compose / 自定义桥接源码
├── docs/UPDATE-GUIDE.md    # ⭐ AI/维护者升级 SOP（防踩坑）
├── scripts/
│   ├── setup.sh            # 一键部署
│   ├── verify-deploy.sh    # 部署后体检（10 定制标记 + proto + 服务）
│   └── update-bot.sh       # 沙箱内安全三方合并上游更新
├── .env.example            # 配置模板（admin/admin 默认值）
├── accounts.example.json   # 账号模板
└── README.md
```

---

## 升级（不要整目录覆盖！）

严格按 [docs/UPDATE-GUIDE.md](docs/UPDATE-GUIDE.md) 的 **3-way merge** 流程。
核心命令：`scripts/update-bot.sh <上游URL> <BASE> <LATEST> <生产bot目录>`，
它在沙箱里构建并合并，把结果放到 `update-out/`，你 Review 后上传，最后跑 `verify-deploy.sh`。
