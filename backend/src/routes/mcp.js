'use strict';
// MCP 服务器（Streamable HTTP 无状态模式，挂载在 /mcp，不在 /api 下）
// - 认证：/mcp?key=<API Key>（也接受 X-API-Key / Authorization: Bearer）
// - 实现 MCP Apps 扩展（SEP-1865，io.modelcontextprotocol/ui）：
//   search_videos / search_live_rooms 关联 ui:// HTML 资源，宿主在沙箱 iframe 中渲染
//   交互式卡片列表，可一键收藏视频（iframe 内回调 favorite_video）或跳转视频页/直播间。
const express = require('express');
const db = require('../db/pool');
const config = require('../config');
const { client: minio, objectUrl } = require('../lib/minio');
const { resolveAuth, isBanned } = require('../middleware/auth');
const { canAccess, publicVideo } = require('./videos');
const { pickEdge } = require('./cdn');
const { videoListHtml, liveListHtml } = require('../lib/mcpUi');

const router = express.Router();

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const UI_MIME = 'text/html;profile=mcp-app';

// 工具内的业务错误（权限/不存在等）→ isError 工具结果，而非 JSON-RPC 错误
class ToolError extends Error {}

// ---- MCP Apps UI 资源（ui:// 预声明模板，宿主可预取） ----
const UI_RESOURCES = [
  {
    uri: 'ui://lvs/video-list.html', name: 'video-list', title: '视频卡片列表',
    description: '视频搜索结果卡片：缩略图/时长/播放量，可一键收藏或跳转播放页',
    mimeType: UI_MIME, html: videoListHtml()
  },
  {
    uri: 'ui://lvs/live-list.html', name: 'live-list', title: '直播间卡片列表',
    description: '直播间卡片：直播状态/主播，可一键跳转直播间',
    mimeType: UI_MIME, html: liveListHtml()
  }
];

function uiResourceMeta() {
  // 缩略图等静态资源来自本站源（/storage 反代），需在 CSP 中放行；
  // openai/* 键为 OpenAI Apps SDK 宿主（ChatGPT）的兼容别名
  return {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [config.publicBaseUrl] } },
    'openai/widgetCSP': { connect_domains: [], resource_domains: [config.publicBaseUrl] },
    'openai/widgetPrefersBorder': true
  };
}

// ---- 工具定义 ----
const TOOLS = [
  {
    name: 'search_videos', title: '搜索视频',
    description: '按关键词搜索站内公开视频（匹配标题与简介，留空列出最新视频）。结果会渲染为交互式卡片列表，用户可在卡片上一键收藏或跳转播放页。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词；留空返回最新视频' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回数量，默认 20' }
      }
    },
    // openai/outputTemplate：OpenAI Apps SDK 宿主的兼容别名
    _meta: { ui: { resourceUri: 'ui://lvs/video-list.html' }, 'openai/outputTemplate': 'ui://lvs/video-list.html' }
  },
  {
    name: 'search_live_rooms', title: '检索直播间',
    description: '列出站内直播间（直播中的排前面），可按关键词过滤标题/简介。结果会渲染为交互式卡片列表，用户可一键跳转进直播间。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '过滤关键词；留空返回全部' } }
    },
    _meta: { ui: { resourceUri: 'ui://lvs/live-list.html' }, 'openai/outputTemplate': 'ui://lvs/live-list.html' }
  },
  {
    name: 'get_video', title: '视频详情',
    description: '获取视频详细信息（标题/简介/作者/时长/播放量/缩略图/页面链接）。',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: '视频 ID（UUID）' },
        password: { type: 'string', description: '私有视频解锁密码（可选）' }
      },
      required: ['video_id']
    }
  },
  {
    name: 'get_video_play_url', title: '视频播放直链',
    description: '获取视频文件的播放/下载直链（默认经公网 CDN 调度，cdn=off 强制回源）。',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: '视频 ID（UUID）' },
        password: { type: 'string', description: '私有视频解锁密码（可选）' },
        cdn: { type: 'string', enum: ['on', 'off'], description: '是否经 CDN，默认 on' }
      },
      required: ['video_id']
    }
  },
  {
    name: 'get_video_subtitles', title: '视频字幕',
    description: '获取视频的字幕列表（WebVTT），include_content=true 时附带字幕文本内容。',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: '视频 ID（UUID）' },
        password: { type: 'string', description: '私有视频解锁密码（可选）' },
        include_content: { type: 'boolean', description: '是否返回 VTT 文本内容，默认 false' }
      },
      required: ['video_id']
    }
  },
  {
    name: 'get_video_comments', title: '视频评论',
    description: '获取视频的评论列表（扁平结构，回复带 parent_id）。',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: '视频 ID（UUID）' },
        password: { type: 'string', description: '私有视频解锁密码（可选）' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '返回数量，默认 100' }
      },
      required: ['video_id']
    }
  },
  {
    name: 'favorite_video', title: '收藏视频',
    description: '一键收藏视频到当前用户的收藏夹（默认「我的收藏」，不存在时自动创建）。',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: '视频 ID（UUID）' },
        collection_name: { type: 'string', description: '收藏夹名称，默认「我的收藏」' }
      },
      required: ['video_id']
    }
  }
];

// ---- 业务实现 ----

function videoCard(v) {
  const p = publicVideo(v);
  return {
    id: p.id, title: p.title, description: (p.description || '').slice(0, 200),
    owner_name: p.owner_name, views: p.views, duration_sec: p.duration_sec,
    visibility: p.visibility, has_password: p.has_password, created_at: p.created_at,
    thumbnail_url: p.thumbnail_url, page_url: `${config.publicBaseUrl}/video/${p.id}`
  };
}

async function loadVideo(videoId, user, password) {
  const { rows } = await db.query(
    `SELECT v.*, u.username AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.id = $1`,
    [videoId]);
  const v = rows[0];
  if (!v) throw new ToolError(`视频不存在：${videoId}`);
  if (!(await canAccess(v, user, password))) {
    throw new ToolError(v.visibility === 'private'
      ? `私有视频《${v.title}》无权访问${v.unlock_password ? '，可传 password 解锁' : ''}`
      : `视频不存在：${videoId}`);
  }
  return v;
}

function streamToString(stream, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => { if ((size += c.length) <= maxBytes) chunks.push(c); });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

const toolHandlers = {
  async search_videos(args, _user) {
    const query = (args.query || '').trim();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const { rows } = await db.query(
      `SELECT v.*, u.username AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id
       WHERE v.visibility = 'public' AND v.status = 'approved' AND (v.title ILIKE $1 OR v.description ILIKE $1)
       ORDER BY v.created_at DESC LIMIT $2`, [`%${query}%`, limit]);
    const videos = rows.map(videoCard);
    const lines = videos.map((v, i) =>
      `${i + 1}. 《${v.title}》 by ${v.owner_name}，${v.views} 次观看（id: ${v.id}，页面：${v.page_url}）`);
    return {
      content: [{
        type: 'text',
        text: videos.length
          ? `找到 ${videos.length} 个视频${query ? `（关键词「${query}」）` : ''}：\n${lines.join('\n')}`
          : `没有找到匹配的视频${query ? `（关键词「${query}」）` : ''}`
      }],
      structuredContent: { site_url: config.publicBaseUrl, query, total: videos.length, videos }
    };
  },

  async search_live_rooms(args, _user) {
    const query = (args.query || '').trim();
    const { rows } = await db.query(
      `SELECT r.*, u.username AS owner_name FROM live_rooms r JOIN users u ON u.id = r.owner_id
       WHERE r.title ILIKE $1 OR r.description ILIKE $1
       ORDER BY r.is_live DESC, r.created_at DESC LIMIT 100`, [`%${query}%`]);
    const rooms = rows.map((r) => ({
      id: r.id, title: r.title, description: (r.description || '').slice(0, 200),
      owner_name: r.owner_name, is_live: r.is_live, live_started_at: r.live_started_at,
      has_password: !!r.password, created_at: r.created_at,
      page_url: `${config.publicBaseUrl}/live/${r.id}`
    }));
    const lines = rooms.map((r, i) =>
      `${i + 1}. ${r.is_live ? '🔴直播中' : '未开播'} 《${r.title}》 主播 ${r.owner_name}${r.has_password ? '（有密码）' : ''}（id: ${r.id}，页面：${r.page_url}）`);
    return {
      content: [{
        type: 'text',
        text: rooms.length ? `共 ${rooms.length} 个直播间：\n${lines.join('\n')}` : '暂无直播间'
      }],
      structuredContent: { site_url: config.publicBaseUrl, query, total: rooms.length, rooms }
    };
  },

  async get_video(args, user) {
    const v = await loadVideo(args.video_id, user, args.password);
    const card = videoCard(v);
    const detail = { ...card, description: v.description || '', size_bytes: Number(v.size_bytes || 0), status: v.status, mime: v.mime };
    return {
      content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
      structuredContent: detail
    };
  },

  async get_video_play_url(args, user) {
    const v = await loadVideo(args.video_id, user, args.password);
    const edge = args.cdn === 'off' ? null : await pickEdge();
    db.query('UPDATE videos SET views = views + 1 WHERE id = $1', [v.id]).catch(() => {});
    const result = {
      video_id: v.id, title: v.title,
      video_url: objectUrl(config.buckets.videos, v.object_key, edge && edge.base_url),
      download_url: objectUrl(config.buckets.videos, v.object_key, edge && edge.base_url),
      mime: v.mime, via_cdn: edge ? edge.name : null,
      page_url: `${config.publicBaseUrl}/video/${v.id}`
    };
    return {
      content: [{ type: 'text', text: `《${v.title}》播放直链：${result.video_url}（mime: ${result.mime}${edge ? `，经 CDN ${edge.name}` : ''}）` }],
      structuredContent: result
    };
  },

  async get_video_subtitles(args, user) {
    const v = await loadVideo(args.video_id, user, args.password);
    const { rows } = await db.query(
      `SELECT s.id, s.lang, s.label, s.format, s.object_key, s.created_at, u.username AS uploader
       FROM subtitles s JOIN users u ON u.id = s.uploader_id WHERE s.video_id = $1 ORDER BY s.id`, [v.id]);
    const subtitles = [];
    for (const s of rows) {
      const item = {
        id: s.id, lang: s.lang, label: s.label, format: s.format, uploader: s.uploader,
        created_at: s.created_at, url: objectUrl(config.buckets.subtitles, s.object_key)
      };
      if (args.include_content) {
        try {
          item.content = await streamToString(await minio.getObject(config.buckets.subtitles, s.object_key));
        } catch {
          item.content = null;
        }
      }
      subtitles.push(item);
    }
    return {
      content: [{
        type: 'text',
        text: subtitles.length
          ? `《${v.title}》共 ${subtitles.length} 条字幕：\n${JSON.stringify(subtitles, null, 2)}`
          : `《${v.title}》暂无字幕`
      }],
      structuredContent: { video_id: v.id, title: v.title, total: subtitles.length, subtitles }
    };
  },

  async get_video_comments(args, user) {
    const v = await loadVideo(args.video_id, user, args.password);
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);
    const { rows } = await db.query(
      `SELECT c.id, c.parent_id, c.content, c.created_at, c.deleted, u.id AS user_id, u.username,
              COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.video_id = $1 ORDER BY c.id ASC LIMIT $2`, [v.id, limit]);
    const comments = rows.map((c) => c.deleted ? { ...c, content: '[已删除]' } : c);
    const lines = comments.map((c) =>
      `#${c.id}${c.parent_id ? `（回复 #${c.parent_id}）` : ''} ${c.display_name}：${c.content}`);
    return {
      content: [{
        type: 'text',
        text: comments.length ? `《${v.title}》共 ${comments.length} 条评论：\n${lines.join('\n')}` : `《${v.title}》暂无评论`
      }],
      structuredContent: { video_id: v.id, title: v.title, total: comments.length, comments }
    };
  },

  async favorite_video(args, user) {
    const v = await loadVideo(args.video_id, user);
    const name = (args.collection_name || '我的收藏').trim().slice(0, 100);
    let { rows } = await db.query(
      'SELECT * FROM collections WHERE owner_id = $1 AND name = $2 ORDER BY created_at LIMIT 1', [user.id, name]);
    let collection = rows[0];
    if (!collection) {
      ({ rows } = await db.query(
        `INSERT INTO collections (owner_id, name, description, visibility) VALUES ($1,$2,'','private') RETURNING *`,
        [user.id, name]));
      collection = rows[0];
    }
    const ins = await db.query(
      `INSERT INTO collection_videos (collection_id, video_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [collection.id, v.id]);
    const already = ins.rowCount === 0;
    const result = {
      ok: true, already, video_id: v.id, video_title: v.title,
      collection_id: collection.id, collection_name: collection.name,
      collection_url: `${config.publicBaseUrl}/collection/${collection.id}`
    };
    return {
      content: [{ type: 'text', text: already ? `《${v.title}》已在收藏夹「${name}」中` : `已将《${v.title}》收藏到「${name}」` }],
      structuredContent: result
    };
  }
};

// ---- JSON-RPC（Streamable HTTP 无状态：POST 收请求，application/json 回响应） ----

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function doInitialize(params) {
  const requested = params && params.protocolVersion;
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18',
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } }
    },
    serverInfo: { name: 'lan-video-station', title: 'LAN Video Station（局域网视频站）', version: '1.0.0' },
    instructions: [
      '局域网视频站 MCP：检索视频/直播间、获取视频详情/播放直链/字幕/评论、一键收藏。',
      'search_videos 与 search_live_rooms 在支持 MCP Apps 的宿主中渲染交互式卡片列表，',
      '用户可在卡片上直接收藏视频或跳转视频页/直播间。video_id 为 UUID；私有视频可传 password 解锁。'
    ].join('')
  };
}

async function callTool(params, user) {
  const name = params && params.name;
  const handler = toolHandlers[name];
  if (!handler) {
    const e = new Error(`unknown tool: ${name}`);
    e.rpcCode = -32602;
    throw e;
  }
  try {
    return await handler((params && params.arguments) || {}, user);
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
    throw e;
  }
}

function readResource(params) {
  const r = UI_RESOURCES.find((x) => x.uri === (params && params.uri));
  if (!r) {
    const e = new Error(`resource not found: ${params && params.uri}`);
    e.rpcCode = -32002;
    throw e;
  }
  return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.html, _meta: uiResourceMeta() }] };
}

async function handleRpc(msg, user) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'invalid request');
  }
  const { id, method } = msg;
  const params = msg.params || {};
  const isNotification = id === undefined || id === null;
  try {
    let result;
    switch (method) {
      case 'initialize': result = doInitialize(params); break;
      case 'ping': result = {}; break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': result = await callTool(params, user); break;
      case 'resources/list':
        result = {
          resources: UI_RESOURCES.map((r) => ({
            uri: r.uri, name: r.name, title: r.title, description: r.description,
            mimeType: r.mimeType, _meta: uiResourceMeta()
          }))
        };
        break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'resources/read': result = readResource(params); break;
      default:
        if (method.startsWith('notifications/')) return null;
        return isNotification ? null : rpcError(id, -32601, `method not found: ${method}`);
    }
    return isNotification ? null : rpcResult(id, result);
  } catch (e) {
    console.error('[mcp]', method, e.message);
    return isNotification ? null : rpcError(id, e.rpcCode || -32603, e.message);
  }
}

// 认证：?key= 优先（MCP 接入串格式），同时兼容 X-API-Key / Bearer
async function mcpAuth(req, res, next) {
  try {
    if (req.query.key) req.headers['x-api-key'] = String(req.query.key);
    const user = await resolveAuth(req);
    if (!user) {
      return res.status(401).json(rpcError(null, -32000,
        'unauthorized：请使用 /mcp?key=<API Key> 连接（API Key 在「个人设置 → API Key」创建）'));
    }
    if (isBanned(user)) {
      return res.status(403).json(rpcError(null, -32000,
        `账号已被封禁至 ${user.banned_until}${user.ban_reason ? `：${user.ban_reason}` : ''}`));
    }
    req.user = user;
    next();
  } catch (e) { next(e); }
}

router.post('/', mcpAuth, async (req, res, next) => {
  try {
    const body = req.body;
    const out = Array.isArray(body)
      ? (await Promise.all(body.map((m) => handleRpc(m, req.user)))).filter(Boolean)
      : await handleRpc(body, req.user);
    if (!out || (Array.isArray(out) && !out.length)) return res.status(202).end();
    res.json(out);
  } catch (e) { next(e); }
});

// 无状态模式：不提供 SSE 推送流与会话终止
router.get('/', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method not allowed：请 POST JSON-RPC 到 /mcp?key=<API Key>' }));
router.delete('/', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' }));

module.exports = router;
