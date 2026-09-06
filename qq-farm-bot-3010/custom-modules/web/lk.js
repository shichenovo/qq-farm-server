/* link-ops 面板内低调管理卡片（服务器定制，custom-modules 升级不覆盖） */
(function () {
    'use strict';
    if (window.__lkInjected) return;
    window.__lkInjected = true;

    var API = '/api/link-ops';
    var APPEND_MS = 1500;

    function token() {
        try { return localStorage.getItem('admin_token') || ''; } catch (e) { return ''; }
    }

    function api(path, method, body) {
        return fetch(API + path, {
            method: method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-token': token(),
            },
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json(); });
    }

    var css = '\
#lkFab{position:fixed;right:14px;bottom:120px;width:34px;height:34px;border-radius:50%;\
background:rgba(30,30,35,.55);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.4);\
font-size:13px;line-height:32px;text-align:center;cursor:pointer;z-index:9998;\
user-select:none;transition:all .2s;backdrop-filter:blur(4px)}\
#lkFab:hover{background:rgba(40,40,48,.85);color:#fff}\
#lkCard{position:fixed;right:14px;bottom:160px;width:330px;max-height:70vh;overflow:auto;\
background:rgba(24,24,28,.95);border:1px solid rgba(255,255,255,.1);border-radius:12px;\
color:#ddd;font:12px/1.5 system-ui,-apple-system,sans-serif;z-index:9999;\
box-shadow:0 8px 30px rgba(0,0,0,.5);display:none;padding:12px}\
#lkCard h4{margin:0 0 8px;font-size:12px;color:#888;font-weight:600;letter-spacing:.5px}\
#lkCard .lk-row{display:flex;gap:6px;margin-bottom:6px}\
#lkCard input{flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);\
border-radius:6px;color:#eee;padding:5px 7px;font-size:12px;outline:none}\
#lkCard input:focus{border-color:rgba(100,150,255,.5)}\
#lkCard button{background:rgba(90,130,255,.15);color:#9db6ff;border:1px solid rgba(90,130,255,.25);\
border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;white-space:nowrap}\
#lkCard button:hover{background:rgba(90,130,255,.28)}\
#lkCard button.danger{background:rgba(255,80,80,.12);color:#ff9d9d;border-color:rgba(255,80,80,.25)}\
#lkCard .lk-item{border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:7px 8px;margin-bottom:6px}\
#lkCard .lk-url{color:#eee;word-break:break-all;font-size:12px}\
#lkCard .lk-meta{color:#888;font-size:11px;margin-top:3px}\
#lkCard .lk-meta b{color:#7fae7f;font-weight:600}\
#lkCard .lk-meta b.err{color:#e08a8a}\
#lkCard .lk-ops{display:flex;gap:6px;margin-top:6px}\
#lkCard .lk-ops button{flex:1;padding:3px 6px;font-size:11px}\
#lkCard .lk-msg{color:#9db6ff;font-size:11px;margin-top:6px;min-height:14px}\
#lkCard .lk-hint{color:#666;font-size:11px;margin-top:8px}\
';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function fmtTime(t) {
        if (!t) return '从未';
        var d = new Date(t);
        var p = function (n) { return n < 10 ? '0' + n : n; };
        return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function card() {
        var el = document.createElement('div');
        el.id = 'lkCard';
        el.innerHTML =
            '<h4>链接巡检</h4>' +
            '<div class="lk-row"><input id="lkUrl" placeholder="http(s):// 目标网址" /></div>' +
            '<div class="lk-row"><input id="lkSec" placeholder="间隔(秒，最小60，默认300)" style="flex:.6" />' +
            '<button id="lkAdd">添加</button><button id="lkTest">测试</button></div>' +
            '<div id="lkList"></div>' +
            '<div class="lk-msg" id="lkMsg"></div>' +
            '<div class="lk-hint">每间隔自动访问一次，保活长链/隧道。运行记录仅本机保存。</div>';
        document.body.appendChild(el);
        return el;
    }

    var fab, panel, listEl, msgEl;

    function msg(s) { msgEl.textContent = s; }

    function render(tasks) {
        var html = '';
        (tasks || []).forEach(function (t) {
            var status;
            if (!t.enabled) status = '已停用';
            else if (!t.lastRun) status = '等待首次执行';
            else if (t.lastCode >= 200 && t.lastCode < 400) status = '正常 HTTP ' + t.lastCode + ' (' + t.lastMs + 'ms)';
            else status = (t.lastError || ('HTTP ' + t.lastCode)) + ' (' + t.lastMs + 'ms)';
            var ok = t.enabled && t.lastCode >= 200 && t.lastCode < 400;
            html += '<div class="lk-item"><div class="lk-url">' + esc(t.url) + '</div>' +
                '<div class="lk-meta">每 ' + t.intervalSec + 's · 上次 ' + fmtTime(t.lastRun) + ' · <b class="' + (ok ? '' : 'err') + '">' + esc(status) + '</b></div>' +
                '<div class="lk-ops">' +
                '<button data-act="toggle" data-id="' + t.id + '">' + (t.enabled ? '停用' : '启用') + '</button>' +
                '<button data-act="ping" data-id="' + t.id + '" data-url="' + esc(t.url) + '">立即访问</button>' +
                '<button data-act="del" data-id="' + t.id + '" class="danger">删除</button>' +
                '</div></div>';
        });
        listEl.innerHTML = html || '<div class="lk-hint">还没有任务</div>';
    }

    function refresh() {
        api('', 'GET').then(function (r) {
            if (!r || !r.ok) { msg('获取失败：' + (r && r.error || '未登录或会话过期')); return; }
            render(r.data.tasks);
        }).catch(function (e) { msg('请求失败：' + e.message); });
    }

    function open() {
        if (!token()) { msg('请先在面板登录（获取访问凭证）'); return; }
        panel.style.display = 'block';
        refresh();
    }

    function init() {
        var st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);

        fab = document.createElement('div');
        fab.id = 'lkFab';
        fab.title = '';
        fab.textContent = '·';
        fab.addEventListener('click', function () {
            if (panel.style.display === 'none') open();
            else { panel.style.display = 'none'; }
        });
        document.body.appendChild(fab);

        panel = card();
        listEl = panel.querySelector('#lkList');
        msgEl = panel.querySelector('#lkMsg');

        panel.querySelector('#lkAdd').addEventListener('click', function () {
            var url = (panel.querySelector('#lkUrl').value || '').trim();
            var sec = parseInt(panel.querySelector('#lkSec').value || '300', 10);
            if (!url) { msg('请填写网址'); return; }
            api('', 'POST', { url: url, intervalSec: sec >= 60 ? sec : 300 }).then(function (r) {
                if (r && r.ok) { panel.querySelector('#lkUrl').value = ''; panel.querySelector('#lkSec').value = ''; msg('已添加'); refresh(); }
                else msg('添加失败：' + (r && r.error || '未知错误'));
            }).catch(function (e) { msg('添加失败：' + e.message); });
        });

        panel.querySelector('#lkTest').addEventListener('click', function () {
            var url = (panel.querySelector('#lkUrl').value || '').trim();
            if (!url) { msg('先填网址再测试'); return; }
            msg('测试中…');
            api('/test', 'POST', { url: url }).then(function (r) {
                if (r && r.ok) msg('测试结果：' + (r.data.error ? r.data.error : 'HTTP ' + r.data.code) + ' (' + r.data.ms + 'ms)');
                else msg('测试失败：' + (r && r.error || '未知错误'));
            }).catch(function (e) { msg('测试失败：' + e.message); });
        });

        listEl.addEventListener('click', function (ev) {
            var btn = ev.target.closest('button[data-act]');
            if (!btn) return;
            var act = btn.getAttribute('data-act');
            var id = btn.getAttribute('data-id');
            var body = { id: id };
            if (act === 'toggle') body.enabled = btn.textContent.indexOf('启用') >= 0;
            if (act === 'ping') {
                msg('访问中…');
                var u = btn.getAttribute('data-url');
                api('/test', 'POST', { url: u }).then(function (r) {
                    if (r && r.ok) { msg('访问结果：' + (r.data.error ? r.data.error : 'HTTP ' + r.data.code) + ' (' + r.data.ms + 'ms)'); refresh(); }
                    else msg('访问失败：' + (r && r.error || '未知错误'));
                }).catch(function (e) { msg('访问失败：' + e.message); });
                return;
            }
            var p = act === 'toggle' ? api('/toggle', 'POST', body) : api('/remove', 'POST', body);
            p.then(function (r) {
                if (r && r.ok) { msg('已' + (act === 'del' ? '删除' : '更新')); refresh(); }
                else msg('操作失败：' + (r && r.error || '未知错误'));
            }).catch(function (e) { msg('操作失败：' + e.message); });
        });
    }

    // 等 SPA 完全渲染后再注入，避免被路由切换清掉
    function boot() {
        if (document.body) {
            init();
        } else {
            document.addEventListener('DOMContentLoaded', init);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        setTimeout(boot, APPEND_MS);
    }
})();
