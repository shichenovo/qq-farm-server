# NapCat 扫码取 Code 网页

一个**完全独立**的网页工具：用真人扫码通道（token:*，独立 QQ 实例）扫 QQ 登录二维码，
取一次性 Code 后自动释放并退出本次扫码的 QQ 实例。**不碰农场bot / yyb-go 任何文件与运行实例。**

## 工作原理

```
浏览器 ──▶ 本服务(:8088) ──▶ /run/qqfarm-napcat-bridge/bridge.sock (NapCat bridge)
```

- bridge 已做**双通道隔离**：`system:*`(农场bot 自动重连) 走 main 通道常驻；`token:*`(本工具) 走 scan 通道，按需拉起**第二个** QQ 实例、用完即回收。
- 因此扫码取 Code **不会踢掉**农场bot 的主 QQ 会话。正常情况 scan 实例能独立拉起；仅当内存/显示器异常拉不起时才短暂降级到主实例。

## 接口（本服务代理透传到 bridge）

| 本服务路径 | 方法 | 说明 |
|---|---|---|
| `/api/bridge/qrcode?owner=token:web_xxx` | GET | 生成/换二维码，返回 `data.qrcode`(base64 PNG) |
| `/api/bridge/status?owner=...` | GET | 轮询扫码状态，返回 `loggedIn`+`profile.uin` |
| `/api/bridge/image?owner=...` | GET | 读当前二维码图（跟随换图） |
| `/api/bridge/refresh?owner=...` | POST | 强制换码 |
| `/api/bridge/authorize` | POST | body `{owner, uin}`，返回 `data.authorization`(一次性 Code) |
| `/api/bridge/release` | POST | body `{owner}`，释放扫码通道并退出本次 QQ 实例 |

## 部署（已在服务器 /opt/napcat-code-web 完成）

```bash
# 1. 上传文件到 /opt/napcat-code-web（server.js / public/ / package.json / *.service）
# 2. 安装为 systemd 服务
cp /opt/napcat-code-web/napcat-code-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now napcat-code-web

# 3. 访问
#    http://服务器IP:8088/

# 4.（可选）开启访问密码，避免外人触发扫码
#    编辑 /etc/systemd/system/napcat-code-web.service，去掉 PASSWORD 行注释并填入强密码，
#    然后 systemctl restart napcat-code-web
```

## 使用流程

1. 打开网页 → 自动生成二维码（owner 随机，单次会话有效）。
2. 用 **QQ** 扫描二维码登录。
3. 状态变为「已登录」后点「取一次性 Code」。
4. 复制 Code 回填到农场bot 账号的 `code` 字段。
5. 取完自动释放扫码通道并退出本次扫码的 QQ 实例；关闭页面也会自动释放。

## 注意

- 取到的 Code 是**一次性**的，用过即失效。
- 不要和农场bot 正在用的同一 QQ 长期占用扫码通道；本工具用完即退。
- 端口默认 8088，与现有 3010(农场bot)/8080(下载)/8450(yyb-go)/6099(napcat) 都不冲突。
