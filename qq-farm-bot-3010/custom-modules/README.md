# 本服务器自定义模块（升级时请勿覆盖）

> ## ⚠️ 最重要规则（AI/人都先看这条）
> - **运行时真源是 **， 只  它。** 不参与运行时加载**，它只是  的【镜像】。
> - 2026-09-02 已把本目录与  逐文件同步一致。今后若执行「叠加部署」(copy custom-modules → dist)，结果为**空操作**，不会回退改动。
> - 改逻辑改 ，然后按相同相对路径反向同步回本目录（见 ）。
> - 上游更新用 **3-way merge**（见仓库 ），**禁止整目录覆盖 dist**。

# 本服务器自定义模块（升级时请勿覆盖）

这些文件是本服务器在 GitHub 上游 `liyangpengs/qq-farm-bot` 之外**自行定制**的，
它们大多**只存在于 `core/dist/`**（服务器上的 `core/src` 是精简过的源码，缺 config/ 与 runtime/）。

> **2026-09-01 事故复盘**：升级时把上游 `dist` 整个覆盖过来，
> 直接删掉了这里的 `napcat-routes.js` / `auto-code-refresh.js` 等文件，
> 导致「扫码登录 QQ」消失、两个账号全部起不来。
>
> **正确升级姿势**：只做**增量合并**——逐个比对上游新增/变更的文件，
> 只替换「上游新功能文件」（activity-center.js、worker.js、config/config.js、proto 等），
> 下面这些文件**必须保留服务器版本**，或用本目录的副本再打一次定制补丁。

## 文件清单

| 文件 | 作用 | 说明 |
| --- | --- | --- |
| `controllers/admin/napcat-routes.js` | 扫码登录 QQ 的面板接口 | 上游没有 |
| `controllers/admin/yyb-wx-routes.js` | 应用宝（微信）换码接口 | 上游没有 |
| `controllers/admin/index.js` | 路由装配 | 在版本上追加挂载上面两组路由 |
| `services/napcat-bridge-client.js` | NapCat Unix Socket 桥客户端 | 上游没有 |
| `services/napcat-openauth.js` | NapCat 开放授权 | 上游没有 |
| `runtime/auto-code-refresh.js` | 自动刷新 Code | 已改造：定时刷新移除，改为掉线触发 |
| `runtime/worker-manager.js` | worker 启停 | 定制：启动前刷 Code、离线重连、startWorker 幂等占位 |
| `runtime/data-provider.js` | 面板数据层 | 追加了公益小红花 4 个方法 |
| `runtime/runtime-engine.js` | 运行时装配 | 接入在线自动挂机服务 |
| `runtime/auto-start-online.js` | **在线自动挂机** | 上游没有，2026-09-02 新增 |

## 在线自动挂机（auto-start-online.js）

- 每 **2 分钟**巡检一次：
  - QQ 账号 → 探测 NapCat 桥 `/health`
  - 应用宝账号 → 探测 `http://127.0.0.1:8450/health`
- **仅当该账号 bot 未运行时**才拉起，四道防死循环闸：
  1. `isAccountRunning()` 前置判断（已在跑就完全不动）
  2. `pending` 集合（上一次 startWorker 没返回就不再进）
  3. 90 秒冷却期（和 worker-manager 的离线重连错开）
  4. 失败指数退避 2→4→8…上限 30 分钟

### 开关与调参

| 方式 | 说明 |
| --- | --- |
| `FARM_AUTO_START_ONLINE=0` | 关闭（写进 systemd 的 Environment） |
| `FARM_AUTO_START_INTERVAL_MIN=5` | 改巡检间隔（分钟） |
| `systemConfig.autoStartOnline.excludeAccountIds: ["1"]` | 排除某个账号，不自动拉起 |

改完执行：`systemctl restart qq-farm-bot-3010`

> 注意：`client.js` 里是 `autoStartAccounts: false`，
> 所以服务重启后账号**不会**自己起来，全靠本服务在 2 分钟内拉起。

## 备份位置

| 路径 | 内容 |
| --- | --- |
| `/opt/qq-farm-bot-3010.bak.20260901-232642` | 升级前完整备份（55M） |
| `/opt/qq-farm-bot-3010.bak.merge-234804` | 保守合并前快照 |
| `/opt/qq-farm-bot-3010.broken-upgrade-20260901` | 出问题的上游版本（用于 diff） |
| `/tmp/asobak/` | 本次改动前的文件级备份 |

---

## 2026-09-02 上游同步（20260828 → 20260902）

上游 commit：`b48a6d7` → `19de58e`。采用**三方合并**（prod / base / latest），未整体覆盖。

### 变更清单

| 类别 | 文件 | 方式 |
| --- | --- | --- |
| 后端 dist | 14 个 `.js`（见下方） | `git merge-file` 三方合并 |
| **proto 定义** | `core/src/proto/activitypb.proto` | 补齐 3 处新增定义 |
| 前端 | `web/dist` 整体 | 沙箱构建后上传（本机无 web/src、无 pnpm） |

14 个后端文件：`config/config.js`、`controllers/admin/activity-center-routes.js`、`core/worker.js`、`models/store/shared-state.js`、`runtime/data-provider.js`、`services/activity-center.js`、`services/activity-gameplay-registry.js`、`services/farm/planting.js`、`services/friend/pet-sync.js`、`services/push.js`、`services/qqvip.js`、`services/warehouse.js`、`utils/low-priority-gate.js`、`utils/proto.js`

其中 `planting.js` 有 1 处冲突，取上游写法 `toNum(reply?.fertilizer?.count)`（与生产原写法等价）。

### ⚠️ 教训一：别只扫 `dist/`

第一次只比对了 `core/dist/**/*.js`，**漏掉 `core/src/proto/`**，
上线后两个账号立刻报：

```
no such type: gamepb.activitypb.CharityRedFlowerProgressRewardResult
```

根因：`utils/proto.js` 里 `root.lookupType('gamepb.activitypb.XXX')` 的类型定义在
`.proto` 文件里，不在 js 里。**上游改 proto 逻辑时，proto 定义文件必须一起更新。**

> 排查手法：`git diff --name-status <base> <latest>` 看**全部**变更文件，
> 不要只盯 dist。`plantpb.proto` 这次也改了，但生产 9/1 已同步过，无需再动。

### ⚠️ 教训二：`.proto` 是混合行尾符

`activitypb.proto` 480 行中 **73 行 CRLF、其余 LF**，是混合行尾。
用 Python 统一「探测到的行尾」写回会把整个文件改坏。
**正确做法**：确认内容差异后，直接用上游文件覆盖（行尾随之统一）。

验证命令（避免被行尾干扰）：

```bash
tr -d '\r' < a.proto > a.lf; tr -d '\r' < b.proto > b.lf; diff a.lf b.lf
```

### 验证方式

```bash
cd /opt/qq-farm-bot-3010/core && node -e "
const m = require('./dist/utils/proto.js');
(async () => { await m.loadProto();
  console.log('类型数', Object.keys(m.types).length);
  console.log('小红花进度奖励:', m.types.CharityRedFlowerProgressRewardResult ? 'OK' : 'MISSING');
})()"
```

### 备份

| 路径 | 内容 |
| --- | --- |
| `/opt/backups/pre-merge3/` | 合并前 8 个后端文件 |
| `/opt/backups/activitypb.proto.bak.*` | proto 补丁前 |
| `/opt/backups/web-dist.bak.1788351422.tar.gz` | 升级前前端 |
| `/opt/upstream-ref/20260902/` | **上游源码快照（下次升级的 base）** |

### 下次升级 SOP

1. `git diff --name-status <旧base> <新latest>` 拿**全部**变更（含 proto、web、package.json）
2. 三方合并：`git merge-file -p <prod> <base> <latest>`
3. proto / 前端单独处理（前端在沙箱构建，别在服务器装 pnpm）
4. 每个 js 过 `node --check`
5. proto 过上面的 `loadProto()` 实加载测试
6. 重启后看 `journalctl -u qq-farm-bot-3010` 有无 `no such type` / `进程报错`
