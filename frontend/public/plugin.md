# LAN Video Station — 插件开发指南（plugin.md）

本页面向 AI Agent（Claude 等）与开发者：如何为本站开发「插件」。
插件 = 一个**站外运行**的小程序：订阅站点事件（WebSocket 或 Webhook），再调用开放 API 完成自动化。
无需修改站点代码，无需特殊的插件框架 —— 任何能发 HTTP / 连 WebSocket 的运行时（Node、Python、Deno、worker…）都可以。

完整 API 参考见同站 [`/agents.md`](/agents.md)（含全部接口与事件 payload schema），本页只讲插件开发模式。

## 0. 基本信息

- Base URL：本页面所在站点源（下文记作 `BASE`，如 `https://video.example.com`）。
- 认证：用户在「个人设置 → API Key」创建 `lvs_` 开头的 Key，与账号同权限。
  - 请求头 `X-API-Key: lvs_xxx` 或 `Authorization: Bearer lvs_xxx`。
  - 需要审核/下架/断流/回复反馈等能力时，必须使用**管理员**账号的 Key。
- 所有接口 JSON 进出（上传是 multipart/form-data）；错误返回 `{ "error": "中文原因" }` + HTTP 状态码。

## 1. 订阅事件：两种方式

### 方式 A：WebSocket（推荐，常驻进程）

```
ws(s)://<站点>/ws?token=lvs_你的Key
```

- 连接即收个人（personal scope）事件；管理员 Key 自动额外收全站（admin scope）事件。
- 每帧是 JSON：`{ scope, type, time, ...payload }`。
- 断线请指数退避重连；可定期发 `{"type":"ping"}` 保活（回 `{"type":"pong"}`）。

### 方式 B：Webhook（插件本身是 HTTP 服务时）

```
POST /api/me/webhooks   { "url": "http://你的服务/hook", "secret": "签名密钥", "events": ["admin.video.uploaded"] }
```

- `events` 留空数组 = 订阅全部。
- 投递为 POST JSON，头 `X-LVS-Event`（类型）与 `X-LVS-Signature`（`hex(HMAC_SHA256(secret, body))`，请校验）。
- 8 秒超时、不重试；漏接的事件可通过 `GET /api/me/webhooks/events` 存档补偿。

全部事件类型与字段见 [`/agents.md` 第四节](/agents.md)。插件最常用的：

- `admin.video.uploaded` — 有新视频上传（管理员）：`{videoId, title, ownerId, ownerName, status, needReview}`
- `admin.feedback.created` — 用户发来反馈（管理员）：`{userId, username, content, ...}`
- `admin.report.created` — 新举报（管理员）
- `video.comment.created` / `video.review.approved` 等 — 自己账号相关（普通用户即可）
- `live.started` / `live.stopped` — 直播状态

## 2. 插件常用 API 速查

```
GET  /api/auth/me                                确认 Key 有效与角色
GET  /api/videos/:id/play?cdn=off                取视频直链（JSON {url}，可下载文件）
POST /api/videos/:id/subtitles                   上传字幕 multipart: file(vtt/srt), lang?, label?
POST /api/admin/videos/:id/approve|reject|takedown   审核（管理员）
POST /api/admin/feedback/:userId/reply           回复用户反馈 {content}（管理员）
POST /api/videos/:id/comments                    发表评论 {content}
POST /api/admin/rooms/:id/cut                    断流 {reason}（管理员）
```

## 3. 完整示例：视频上传自动添加字幕并审核

需求：每当有人上传视频 → 自动语音识别生成字幕 → 挂到视频上 → 自动过审。
需要管理员 API Key。Node ≥ 22 可直接运行（内置 fetch / WebSocket / FormData）。

```js
// auto-subtitle.js — 视频上传自动加字幕并过审
const BASE = process.env.LVS_BASE;          // 如 https://video.example.com
const KEY  = process.env.LVS_API_KEY;       // 管理员 lvs_ Key
const H = { 'X-API-Key': KEY };

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json().catch(() => null);
}

// 用你的 ASR 服务实现（whisper.cpp / faster-whisper / 云 API），输入视频 URL，输出 WebVTT 文本
async function transcribeToVtt(videoUrl) {
  // const audio = await fetch(videoUrl) ... 调用 whisper ... 返回 vtt 字符串
  return 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n（示例字幕）\n';
}

async function handleUpload(ev) {
  console.log('新视频:', ev.videoId, ev.title);
  // 1) 取直链（强制回源，绕过 CDN）
  const { url } = await api(`/api/videos/${ev.videoId}/play?cdn=off`);
  // 2) 生成字幕
  const vtt = await transcribeToVtt(url);
  // 3) 上传字幕
  const fd = new FormData();
  fd.append('file', new Blob([vtt], { type: 'text/vtt' }), 'auto.vtt');
  fd.append('lang', 'zh');
  fd.append('label', '中文（自动生成）');
  await api(`/api/videos/${ev.videoId}/subtitles`, { method: 'POST', body: fd });
  // 4) 待审核的自动过审
  if (ev.needReview) await api(`/api/admin/videos/${ev.videoId}/approve`, { method: 'POST' });
  console.log('完成:', ev.videoId);
}

function connect() {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${KEY}`);
  ws.onopen = () => console.log('已连接事件流');
  ws.onmessage = async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'admin.video.uploaded') {
      handleUpload(ev).catch((err) => console.error('处理失败', ev.videoId, err.message));
    }
  };
  ws.onclose = () => setTimeout(connect, 3000); // 自动重连
}
connect();
```

运行：

```bash
LVS_BASE=https://站点 LVS_API_KEY=lvs_xxx node auto-subtitle.js
```

## 4. 其他插件模式

- **反馈客服机器人**：监听 `admin.feedback.created`，把 `content` 交给 LLM 生成回复，调 `POST /api/admin/feedback/:userId/reply`。回复会出现在用户的「系统消息」会话并触发右下角弹窗。
- **内容安全审核**：监听 `admin.video.uploaded`，下载视频抽帧/转写后送审核模型，违规则 `POST /api/admin/videos/:id/reject` 或 `takedown`；弹幕监听 `admin.chat.message`，违规直播 `POST /api/admin/rooms/:id/cut`。
- **直播通知**：监听 `live.started`，转发到 IM/邮件。
- **自动评论/互动**：监听 `video.review.approved`，`POST /api/videos/:id/comments` 发首条评论。
- **数据归档**：定时拉 `GET /api/admin/events`，写入自己的数仓。

## 5. 注意事项

- 私聊消息是端到端加密的：事件里 `chat.message.new`（direct）的 `content` 是密文，插件**无法**读取，这是设计而非 bug。系统消息与反馈（system 会话）是明文，可正常处理。
- Webhook 不重试：要求强可靠请用 WebSocket + 事件存档补偿。
- 自动过审插件请确认站点开着「审核模式」（`GET /api/admin/settings` 的 `review_required`），免审模式下视频会直接上架。
- 出错信息为中文明确原因（403/503 等），请如实上报给用户，不要重试绕过权限。
