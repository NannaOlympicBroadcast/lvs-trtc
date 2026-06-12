'use strict';
// MCP Apps（SEP-1865）UI 资源：嵌入宿主沙箱 iframe 的 HTML 模板。
// 模板是静态的（宿主可预取缓存），数据由 ui/notifications/tool-result 推入；
// iframe 与宿主之间通过 postMessage 走 MCP JSON-RPC（ui/initialize、tools/call、ui/open-link 等）。
// 注意：内嵌脚本只用字符串拼接，避免与外层模板字符串的 ${} 冲突。

const SHARED_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: transparent; --fg: #1c1e21; --muted: #65676b;
    --card: #f5f6f8; --border: #e3e5e8; --accent: #2f6fed; --accent-fg: #fff;
    --ok: #1a7f37; --live: #e02020;
  }
  [data-theme="dark"] {
    --fg: #e7e9ea; --muted: #9aa0a6; --card: #232629; --border: #3a3d41;
    --accent: #4d8dff; --ok: #4ade80;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --fg: #e7e9ea; --muted: #9aa0a6; --card: #232629; --border: #3a3d41;
      --accent: #4d8dff; --ok: #4ade80;
    }
  }
  html, body { background: var(--bg); color: var(--fg); }
  body { font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; padding: 8px; }
  .head { color: var(--muted); margin: 0 2px 10px; }
  .empty { color: var(--muted); text-align: center; padding: 28px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
  .thumb { position: relative; aspect-ratio: 16/9; background: rgba(127,127,127,.15); display: flex; align-items: center; justify-content: center; font-size: 26px; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .dur { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.72); color: #fff; font-size: 11px; font-style: normal; padding: 1px 5px; border-radius: 4px; }
  .thumb .badge { position: absolute; left: 6px; top: 6px; font-size: 11px; font-style: normal; padding: 1px 7px; border-radius: 10px; color: #fff; background: rgba(0,0,0,.6); }
  .thumb .badge.on { background: var(--live); }
  .body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .title { font-weight: 600; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.7em; }
  .meta { color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 6px; margin-top: auto; padding-top: 6px; }
  button { flex: 1; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 7px; padding: 5px 0; font-size: 13px; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  button:disabled { opacity: .6; cursor: default; }
  button.done { color: var(--ok); border-color: var(--ok); }
`;

// iframe ↔ 宿主桥：MCP JSON-RPC over postMessage（视图先发 ui/initialize，宿主推 tool-result）
const BRIDGE_JS = `
  (function () {
    'use strict';
    var nextId = 1, pending = {};
    function post(msg) { window.parent.postMessage(msg, '*'); }
    function request(method, params) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
      });
    }
    function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
    function applyHostContext(ctx) {
      if (ctx && ctx.theme) document.documentElement.setAttribute('data-theme', ctx.theme);
    }
    window.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m || m.jsonrpc !== '2.0') return;
      if (m.id !== undefined && m.method === undefined) { // 响应
        var p = pending[m.id];
        if (p) { delete pending[m.id]; if (m.error) p.reject(m.error); else p.resolve(m.result); }
        return;
      }
      if (m.method === 'ui/notifications/tool-result') { window.__onToolResult && window.__onToolResult(m.params || {}); }
      else if (m.method === 'ui/notifications/tool-input') { window.__onToolInput && window.__onToolInput(m.params || {}); }
      else if (m.method === 'ui/notifications/host-context-changed') { applyHostContext(m.params || {}); }
      else if (m.id !== undefined) { post({ jsonrpc: '2.0', id: m.id, result: {} }); } // 如 ui/resource-teardown
    });
    function reportSize() {
      notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight + 4 });
    }
    window.mcpBridge = { request: request, notify: notify, reportSize: reportSize };
    request('ui/initialize', {
      appInfo: { name: 'lvs-mcp-app', version: '1.0.0' },
      appCapabilities: {}
    }).then(function (res) {
      applyHostContext((res && res.hostContext) || {});
      notify('notifications/initialized');
    }).catch(function () { /* 宿主未实现时静默 */ });
  })();
`;

const HELPERS_JS = `
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h ? h + ':' + p(m) : String(m)) + ':' + p(s);
  }
  function openLink(url) { window.mcpBridge.request('ui/open-link', { url: url }).catch(function () {}); }
`;

const VIDEO_LIST_JS = `
  var state = { site: '', videos: [] };
  window.__onToolInput = function () {
    document.getElementById('app').innerHTML = '<div class="empty">正在检索视频…</div>';
  };
  window.__onToolResult = function (params) {
    var sc = params.structuredContent || {};
    state.site = sc.site_url || '';
    state.videos = sc.videos || [];
    render(sc);
  };
  function render(sc) {
    var el = document.getElementById('app');
    if (!state.videos.length) {
      el.innerHTML = '<div class="empty">没有找到匹配的视频</div>';
      window.mcpBridge.reportSize();
      return;
    }
    var html = '<div class="head">' +
      (sc.query ? '「' + esc(sc.query) + '」的搜索结果 · ' : '') + state.videos.length + ' 个视频</div><div class="grid">';
    state.videos.forEach(function (v) {
      html += '<div class="card">' +
        '<div class="thumb">' +
        (v.thumbnail_url ? '<img src="' + esc(v.thumbnail_url) + '" alt="" loading="lazy">' : '<span>🎬</span>') +
        (v.duration_sec ? '<i class="dur">' + fmtDur(v.duration_sec) + '</i>' : '') +
        '</div><div class="body">' +
        '<div class="title" title="' + esc(v.title) + '">' + esc(v.title) + '</div>' +
        '<div class="meta">' + esc(v.owner_name || '') + ' · ' + (v.views || 0) + ' 次观看</div>' +
        '<div class="actions">' +
        '<button class="primary" data-act="open" data-id="' + esc(v.id) + '">▶ 播放</button>' +
        '<button data-act="fav" data-id="' + esc(v.id) + '">☆ 收藏</button>' +
        '</div></div></div>';
    });
    el.innerHTML = html + '</div>';
    window.mcpBridge.reportSize();
  }
  document.getElementById('app').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var v = state.videos.filter(function (x) { return x.id === id; })[0];
    if (!v) return;
    if (btn.getAttribute('data-act') === 'open') {
      openLink(v.page_url || (state.site + '/video/' + id));
      return;
    }
    btn.disabled = true;
    btn.textContent = '收藏中…';
    window.mcpBridge.request('tools/call', { name: 'favorite_video', arguments: { video_id: id } })
      .then(function (r) {
        if (r && r.isError) throw new Error('failed');
        btn.textContent = '✓ 已收藏';
        btn.classList.add('done');
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = '收藏失败，重试';
      });
  });
`;

const LIVE_LIST_JS = `
  var state = { site: '', rooms: [] };
  window.__onToolInput = function () {
    document.getElementById('app').innerHTML = '<div class="empty">正在获取直播间…</div>';
  };
  window.__onToolResult = function (params) {
    var sc = params.structuredContent || {};
    state.site = sc.site_url || '';
    state.rooms = sc.rooms || [];
    render(sc);
  };
  function render(sc) {
    var el = document.getElementById('app');
    if (!state.rooms.length) {
      el.innerHTML = '<div class="empty">暂无直播间</div>';
      window.mcpBridge.reportSize();
      return;
    }
    var liveCount = state.rooms.filter(function (r) { return r.is_live; }).length;
    var html = '<div class="head">' +
      (sc.query ? '「' + esc(sc.query) + '」的搜索结果 · ' : '') +
      state.rooms.length + ' 个直播间，' + liveCount + ' 个直播中</div><div class="grid">';
    state.rooms.forEach(function (r) {
      html += '<div class="card">' +
        '<div class="thumb"><span>' + (r.is_live ? '📺' : '🌙') + '</span>' +
        '<i class="badge' + (r.is_live ? ' on' : '') + '">' + (r.is_live ? '● 直播中' : '未开播') + '</i>' +
        '</div><div class="body">' +
        '<div class="title" title="' + esc(r.title) + '">' + (r.has_password ? '🔒 ' : '') + esc(r.title) + '</div>' +
        '<div class="meta">主播：' + esc(r.owner_name || '') +
        (r.is_live && r.live_started_at ? '<br>开播于 ' + new Date(r.live_started_at).toLocaleString() : '') + '</div>' +
        '<div class="actions">' +
        '<button class="primary" data-id="' + esc(r.id) + '">' + (r.is_live ? '▶ 进入直播间' : '进入房间') + '</button>' +
        '</div></div></div>';
    });
    el.innerHTML = html + '</div>';
    window.mcpBridge.reportSize();
  }
  document.getElementById('app').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-id]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var r = state.rooms.filter(function (x) { return x.id === id; })[0];
    openLink((r && r.page_url) || (state.site + '/live/' + id));
  });
`;

function page(title, initialText, scriptJs) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div id="app"><div class="empty">${initialText}</div></div>
<script>${BRIDGE_JS}</script>
<script>${HELPERS_JS}${scriptJs}</script>
</body>
</html>`;
}

function videoListHtml() {
  return page('视频列表', '等待视频数据…', VIDEO_LIST_JS);
}

function liveListHtml() {
  return page('直播间列表', '等待直播间数据…', LIVE_LIST_JS);
}

module.exports = { videoListHtml, liveListHtml };
