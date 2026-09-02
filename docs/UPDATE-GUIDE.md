# QQ Farm Bot 升级 SOP（写给 AI / 下一个维护者）

> 目标：把上游 `liyangpengs/qq-farm-bot` 的更新合进来，**绝不破坏本服务器的定制功能**。
> 本文件是 2026-09-02 一次真实升级踩坑后总结的，照做就不会重蹈覆辙。

---

## 0. 先记住一句话

**运行时真源是 `qq-farm-bot-3010/core/dist/*`。`custom-modules/` 只是它的镜像，不参与加载。**
任何"升级"都只动 `core/dist/*`（加一个 3-way merge），不要整目录覆盖，也不要去动 `custom-modules` 之外的别的东西。

---

## 1. 系统由哪些东西组成（谁加载谁）

| 组件 | 路径 | 是否运行时真源 | 说明 |
|---|---|---|---|
| 农场 Bot | `qq-farm-bot-3010/core/dist/*` | ✅ 是 | `core/client.js` 只 `require` 这里。改逻辑改这里。 |
| 定制模块镜像 | `qq-farm-bot-3010/custom-modules/*` | ❌ 否 | 与 `core/dist` 同名文件逐字节一致（2026-09-02 起）。**仅作存档/对照**，不参与加载。叠加部署时它是空操作。 |
| 前端 | `qq-farm-bot-3010/web/dist/*` | ✅ 是 | 由 `web/src` 构建而来；**本服务器只有 dist，没有 src**。前端有定制（金币按单位显示）。 |
| 资源目录 | `qq-farm-bot-3010/core/src/*` | ✅ 部分 | 只有图片/proto/json/wasm。**proto 定义文件在这里被加载**（不是 .js 里）。 |
| gid-tool-web | `/opt/gid-tool-web` (端口 8099) | ✅ | 好友 GID 提取，独立 node 服务。 |
| napcat-code-web | `/opt/napcat-code-web` (端口 8088) | ✅ | NapCat 扫码取 Code 网页，独立 node 服务。**需访问密码**。 |
| qq-farm-download | `/opt/downloads` (端口 8080) | ✅ | python http.server 静态下载服务。 |
| yyb-go | `/opt/yyb-go` (端口 8450) | ✅ | 应用宝(微信)换码 Go 服务。 |
| napcat 容器 | docker `napcat-farm` | ✅ | 提供 `/run/qqfarm-napcat-bridge/bridge.sock`，bot/8088/gid 都靠它。 |
| yyb-keepalive.timer | systemd timer (30min) | ✅ | 微信 login_buffer 保活，**与 QQ Code 刷新是两回事**。 |

**关键**：`core/client.js` 加载链 = `core/dist/controllers/admin` + `core/dist/runtime/runtime-engine` + `core/dist/core/worker`。
**`custom-modules` 不在加载链上** —— 这是最容易误判的地方。

---

## 2. 五个必踩的坑（已踩过，记下来了）

### 坑一：只扫 `dist/*.js` 会漏掉 `proto` 定义文件
上游改逻辑时，往往连 `.proto` 定义一起改。`utils/proto.js` 里 `root.lookupType('gamepb.activitypb.XXX')`
的类型定义在 `core/src/proto/*.proto` 里，**不在 js 里**。
漏了它 → 上线即报 `no such type: gamepb.activitypb.XXX`，两个账号当场挂。

✅ 正确做法：升级第一步永远是
```bash
git diff --name-status <BASE> <LATEST>
```
看**全部**变更文件，别只盯 `core/dist`。proto / web / package.json 一并处理。

### 坑二：`.proto` 是混合行尾符
`activitypb.proto` 480 行里 73 行 CRLF、其余 LF。用 Python 统一行尾会把整个文件写坏。
✅ 确认内容差异后，**直接用上游文件覆盖**（行尾随之统一）。
验证命令（避免被行尾干扰）：
```bash
tr -d '\r' < a.proto > a.lf; tr -d '\r' < b.proto > b.lf; diff a.lf b.lf
```

### 坑三：前端是定制过的，不能整体覆盖
生产 `web/dist` 有定制（金币按单位显示）。上游 `web/dist` 没有。
✅ 正确做法：拿上游 `web/src` 在**沙箱**构建（`pnpm install` + `pnpm build`），
把定制逻辑（如 `Dashboard.vue` 的 `formatAssetAmount` 万/亿换算）移植进去再构建，
产物上传覆盖。**别在服务器装 pnpm**（内存小、会拖慢线上）。

### 坑四：以为 `custom-modules` 是运行时真源
它不是。它只是 `core/dist` 的镜像。改 `core/dist` 后，手动把对应文件反向同步回 `custom-modules`，
让两者保持一致（见 `custom-modules/SYNCED_WITH_DIST.mark`）。这样未来任何"叠加部署"都是空操作。

### 坑五：proto 类型必须实加载验证
光 `diff` 不够。合完 proto 后必须跑一次实加载，确认新类型能 `lookup` 到：
```bash
cd qq-farm-bot-3010/core && node -e "
const m = require('./dist/utils/proto.js');
(async () => { await m.loadProto();
  console.log('小红花进度奖励:', m.types.CharityRedFlowerProgressRewardResult ? 'OK' : 'MISSING');
})()"
```

---

## 3. 标准升级流程（3-way merge）

每次升级都用 `prod / base / latest` 三方合并，能干净区分"上游改动"和"本服务器定制"。

```bash
# 1) 拉上游，记录 BASE(当前生产对应的上游提交) 与 LATEST(要升级到的提交)
git clone https://github.com/liyangpengs/qq-farm-bot /tmp/upstream
cd /tmp/upstream
BASE=b48a6d7   # 生产当前对应的上游版本
LATEST=19de58e  # 目标版本

# 2) 全量变更清单（含 proto/web/package.json！）
git diff --name-status $BASE $LATEST

# 3) 构建 base 与 latest 的 dist（在沙箱，别在服务器）
git checkout $BASE && pnpm install && pnpm build:ts && cp -r core/dist /tmp/base-dist
git checkout $LATEST && pnpm install && pnpm build:ts && cp -r core/dist /tmp/up-dist

# 4) 对每个"上游改动且生产也改过"的文件做三方合并
#    prod = 生产当前文件, base = 上游 BASE 的该文件, latest = 上游 LATEST 的该文件
git merge-file -p <prod> <base> <latest> > <merged>
#    无冲突 → 直接用；有冲突 → 人工看，通常取 latest 写法（与本服务器原写法等价时）

# 5) proto 文件单独处理：直接拿上游覆盖（见坑二），再跑坑五的实加载验证
# 6) 每个改动的 js 过 node --check
# 7) 重启服务，看 journalctl 有无 no such type / 进程报错
```

> 本服务器已把上游快照存到 `/opt/upstream-ref/<日期>/`，下次升级直接拿它当 BASE。
> 升级 SOP 与脚本见仓库 `scripts/update-bot.sh` 与 `scripts/verify-deploy.sh`。

---

## 4. 验证清单（每次部署/升级后必跑）

运行 `scripts/verify-deploy.sh`，它检查：
- 10 个定制标记是否都在 `core/dist`（NapCat/YYB 换码、自动刷新、GID 手动锁、小红花等）
- proto 能否实加载新类型
- 各服务是否 active
- 近 N 分钟 `no such type` / `进程报错` 是否归零

只要脚本全绿，就可以放心。

---

## 5. 不要做的事

- ❌ 不要 `rm -rf core/dist && cp 上游 dist` 整目录覆盖（会删掉所有定制）。
- ❌ 不要只比 `core/dist/*.js` 就以为改完了（漏 proto/web）。
- ❌ 不要在生产机 `pnpm install` / `pnpm build`（内存小、影响线上）。
- ❌ 不要把 `custom-modules` 当运行时真源去改它（改了也不生效）。
- ❌ 不要把真实 token / 账号 / 密码提交到仓库（见 `.env.example`、`accounts.example.json`）。
