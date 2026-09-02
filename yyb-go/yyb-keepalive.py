#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信(YYB)登录态保活脚本
定期调用 yyb-go 的 /wxapp/getCode (带 openid, 走 Farm5 兼容路径强制 refresh)，
触发 RefreshLoginBuffer 续命 login_buffer，使账号即使长期停机也不会 expired。
配合 systemd timer 每 30 分钟执行一次。
"""
import json
import sys
import time
import os
import urllib.request

YYB_API_URL = os.environ.get("YYB_API_URL", "http://127.0.0.1:8450")
YYB_API_TOKEN = os.environ.get("YYB_API_TOKEN", "REPLACE_WITH_YOUR_YYB_TOKEN")
WX_APP_ID = "wx5306c5978fdb76e4"
# 账号3(微信)的 openid —— 与 accounts.json 中 yybOpenid 一致
WX_OPENID = os.environ.get("WX_OPENID", "REPLACE_WITH_YOUR_WX_OPENID")


def refresh_once():
    url = YYB_API_URL + "/wxapp/getCode"
    body = json.dumps({"openid": WX_OPENID, "app_id": WX_APP_ID}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + YYB_API_TOKEN,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", "replace")
    data = json.loads(raw)
    code = data.get("code")
    msg = data.get("msg", "")
    if code == 0:
        return True, "ok (code refreshed)"
    if code == 409 or "expired" in msg:
        return False, "login_buffer expired (refresh failed); re-scan required"
    return False, "unexpected: code=%s msg=%s" % (code, msg)


def main():
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        ok, detail = refresh_once()
    except Exception as e:
        print("[%s] YYB_KEEPALIVE FAIL exception=%s" % (ts, e), flush=True)
        sys.exit(1)
    if ok:
        print("[%s] YYB_KEEPALIVE OK %s" % (ts, detail), flush=True)
        sys.exit(0)
    else:
        # 续命失败：login_buffer 已过期，需要重新扫码。打印明显告警，但 exit 0 避免 timer 报错风暴。
        print("[%s] YYB_KEEPALIVE WARN %s" % (ts, detail), flush=True)
        sys.exit(0)


if __name__ == "__main__":
    main()
