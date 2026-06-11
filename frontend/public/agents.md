# LAN Video Station — Agent 操作指南（agents.md）

本页面向 AI Agent（Claude / Codex / Antigravity / Manus / OpenClaw 等），说明如何通过开放 API 操作本站。
本站是局域网自托管视频平台：视频点播（上传/审核/评论/字幕/收藏夹）+ 直播连麦（基于腾讯云 TRTC）+ 事件推送（WebSocket/Webhook）。

## 基本约定

- Base URL：本页面所在站点源，即 `<前端url>`；全部接口在 `<前端url>/api/...` 下。
- 认证（二选一，所有需登录接口通用）：
  - `X-API-Key: lvs_xxx`
  - `Authorization: Bearer lvs_xxx`（也接受 JWT）
  - API Key 在「个人设置 → API Key」创建，与账号同权限（普通用户/管理员）。
- 请求/响应均为 JSON（上传除外，multipart/form-data）；出错时返回 `{ "error": "原因" }` 与对应 HTTP 状态码。
- 直播连麦基于腾讯云 TRTC：相关接口返回 TRTC 进房参数（`sdk_app_id` / `str_room_id` / `user_id` / `user_sig` / `role`）。服务端未配置 TRTC 凭证时这些接口返回明确错误（HTTP 503），不会降级。

---

## 一、普通用户接口

注册/登录/个人资料：

```
POST /api/auth/register        {username, password, email?}
POST /api/auth/login           {username, password} → {token}（JWT）
GET  /api/auth/me              当前用户信息
PATCH /api/auth/profile        修改显示昵称/简介 {nickname?, bio?}（昵称留空回退用户名）
POST /api/auth/password        修改密码 {old_password, new_password}
```

API Key 与个人 Webhook：

```
GET|POST /api/keys             列出 / 创建 API Key（POST {name}，token 仅返回一次）
DELETE   /api/keys/:id         删除 Key
GET|POST /api/me/webhooks      个人 Webhook 列表 / 创建 {url, secret?, events?[]}
PATCH|DELETE /api/me/webhooks/:id   启停 {enabled} / 删除
GET /api/me/webhooks/events    我的最近事件存档
```

视频点播：

```
GET  /api/videos?q=关键词       公开视频列表（已上架）
GET  /api/videos/mine          我的视频
POST /api/videos               上传（multipart: file, title, description?, visibility=public|private, unlock_password?, collection_id?）
GET  /api/videos/:id           视频详情
GET  /api/videos/:id/play      播放/下载直链（公网 CDN 调度，?cdn=off 强制回源；私有视频可带 ?password=）
PATCH /api/videos/:id          修改标题/简介/可见性/解锁密码（视频主）
DELETE /api/videos/:id         删除（视频主/管理员）
GET|POST /api/videos/:id/whitelist      私有视频白名单 / 添加 {username}（视频主）
DELETE /api/videos/:id/whitelist/:uid   移除白名单
GET|POST /api/videos/:id/comments       评论列表 / 发评论 {content, parent_id?}
DELETE /api/videos/:id/comments/:cid    删评论（本人/视频主/管理员）
GET|POST /api/videos/:id/subtitles      字幕列表 / 上传字幕（multipart: file(vtt/srt), lang?, label?）
DELETE /api/videos/:id/subtitles/:sid   删字幕
POST /api/reports              举报 {target_type: video|comment, target_id, reason}
GET  /api/reports/mine         我的举报
```

聊天（端到端加密私聊 + 系统消息/反馈通道）：

```
PUT  /api/chat/keys                          上传聊天公钥 {public_key}（ECDH P-256 JWK 的 JSON 字符串）
GET  /api/chat/keys/:userId                  查询某用户公钥
GET  /api/chat/conversations                 会话列表（系统消息会话置顶；含 peer 公钥/最后消息/未读数）
POST /api/chat/conversations                 发起私聊 {username 或 user_id}
GET  /api/chat/conversations/:id/messages    消息历史（?before_id= 翻旧页，?limit=）
POST /api/chat/conversations/:id/messages    发消息 {content, encrypted?, iv?}
POST /api/chat/conversations/:id/read        标记已读
```

- 私聊（type=direct）强制端到端加密：双方先各自 `PUT /api/chat/keys` 上传 ECDH P-256 公钥；
  发送方用 `ECDH(自己私钥, 对方公钥) → HKDF-SHA256(salt=32字节0, info="lvs-chat-v1") → AES-256-GCM`
  加密，`content` 为密文 base64，`iv` 为 12 字节 IV 的 base64，`encrypted=true`。服务器只存密文，无法解密。
- 系统消息会话（type=system，每用户默认一个）：站点通知（审核结果/举报受理/下架/封禁/新评论）会推送到这里；
  用户在该会话发送的消息（明文）作为反馈直达管理员（触发管理员事件 `admin.feedback.created`）。

收藏夹：

```
GET  /api/collections/mine     我的收藏夹
POST /api/collections          创建 {name, description?, visibility}
GET  /api/collections/:id      详情（公开收藏夹可分享）
PATCH|DELETE /api/collections/:id
POST /api/collections/:id/videos        添加视频 {video_id}
DELETE /api/collections/:id/videos/:vid 移除视频
```

观看直播 / 连麦（观众侧）：

```
GET  /api/live/rooms                直播间列表
POST /api/live/rooms/:id/watch      获取观看参数 {password?} →
                                    { room, trtc(进房参数, role=audience), anchor_user_ids, mic_streams }
                                    用 trtc-sdk-v5 以 strRoomId 进房订阅主播/连麦者画面
POST /api/live/rooms/:id/mic/request        申请连麦 {password?} → {micId}
POST /api/live/rooms/:id/mic/:micId/live    （被同意后）发布成功上报 → 全房广播 mic.live
POST /api/live/rooms/:id/mic/:micId/end     结束自己的连麦
GET  /api/live/rooms/:id/messages   聊天历史
```

连麦流程：`mic/request` → 等待主播决定（个人 WebSocket 事件 `mic.approved`，附 TRTC anchor 进房参数）→ 以 anchor 身份发布音视频（已在房内则 switchRole）→ 调 `mic/:micId/live` 上报 → 收到 `mic.ended` 后停止发布。

## 二、主播接口

直播间管理（直播间归属创建者）：

```
POST /api/live/rooms                创建直播间 {title, description?, password?}
GET  /api/live/rooms/:id            直播间信息（主播可见 stream_key/password/publish 推流参数）
PATCH /api/live/rooms/:id           修改 {title?, description?, password?}（密码传 "" 取消）
GET  /api/live/rooms/:id/stream-urls  推流参数：
                                    { trtc(anchor 进房参数), rtmp_push: {server, stream_key, url} }
POST /api/live/rooms/:id/live/start 标记开播（网页开播自动调用；OBS 推流后需手动/由 Agent 调用）
POST /api/live/rooms/:id/live/stop  标记下播（同时结束所有连麦会话）
```

推流方式二选一：

1. 网页开播：用 `trtc` 参数经 trtc-sdk-v5 进房（scene=live, role=anchor），`startLocalVideo/startLocalAudio` 或 `startScreenShare`，再调 `live/start`。
2. OBS/FFmpeg RTMP 推流进 TRTC 房间：服务器填 `rtmp_push.server`，推流码填 `rtmp_push.stream_key`（需腾讯云开通 RTC-Engine 基础版/专业版套餐），推流后调 `live/start`。

连麦管理：

```
GET  /api/live/rooms/:id/mic                    连麦请求/进行中列表（含 rtc_user_id）
POST /api/live/rooms/:id/mic/:micId/decision    同意/拒绝 {approve: true|false}
POST /api/live/rooms/:id/mic/:micId/end         结束某人连麦
```

黑名单 / 直播间 Webhook / 历史录制：

```
GET|POST /api/live/rooms/:id/blacklist          黑名单列表 / 拉黑 {username 或 user_id}
DELETE   /api/live/rooms/:id/blacklist/:userId  移除
GET|POST /api/live/rooms/:id/webhooks           直播间事件回调列表 / 创建 {url, secret?, events?[]}
DELETE   /api/live/rooms/:id/webhooks/:whId     删除
GET      /api/live/rooms/:id/recordings         历史录制文件（只读；服务端录制已移除，新录制请用腾讯云 TRTC 云端录制）
```

## 三、管理员接口

```
GET  /api/admin/settings                       站点设置
PUT  /api/admin/settings/review_required       免审开关 {value: true|false}
GET  /api/admin/videos?status=pending|approved|rejected|taken_down   全量视频
POST /api/admin/videos/:id/approve             审核通过
POST /api/admin/videos/:id/reject              拒绝 {reason}
POST /api/admin/videos/:id/takedown            下架 {reason}
GET  /api/admin/rooms                          全部直播间
POST /api/admin/rooms/:id/cut                  断流 {reason?}（标记下播 + 广播 live.cut，主播端立即退出 TRTC 房间）
GET  /api/admin/users?q=                       用户搜索
POST /api/admin/users/:id/ban                  封禁 {hours, reason}（hours=0 解封）
GET  /api/admin/reports?status=open            举报列表
POST /api/admin/reports/:id/resolve            处理 {action: resolved|dismissed, note?}（同时通知举报人）
GET  /api/admin/feedback?limit=                全部用户反馈（系统消息会话中用户发送的内容）
POST /api/admin/feedback/:userId/reply         回复反馈 {content}（写入该用户系统消息会话）
GET  /api/admin/events?limit=                  管理员事件存档
GET|POST|PATCH|DELETE /api/cdn/nodes           公网 CDN 节点管理 {name, base_url}
POST /api/cdn/nodes/check                      节点健康检查
```

## 四、事件推送（WebSocket / Webhook）

### 订阅方式

- WebSocket：`ws(s)://站点/ws?token=<JWT 或 API Key>`。连接即收个人事件；发送 `{"type":"join","roomId":"...","password":"..."}` 进直播间收房间事件，`{"type":"chat","roomId":"...","content":"..."}` 发弹幕。管理员自动收全站（admin scope）事件。
- Webhook：在「个人设置 → 事件 Webhook」或 `POST /api/me/webhooks` 配置 `{url, secret?, events?[]}`（events 留空 = 全部）。事件以 POST JSON 投递，8 秒超时，不重试。
- 事件存档：`GET /api/me/webhooks/events`（个人）/ `GET /api/admin/events`（管理员广播）。

### 消息封包 Schema

WebSocket 帧（JSON）：

```json
{
  "scope":  "personal | admin | room",   // 事件通道：个人 / 管理员广播 / 直播间
  "type":   "video.uploaded",            // 事件类型，见下表
  "time":   "2026-01-01T00:00:00.000Z",  // ISO8601 发生时间
  "...payload 字段（随事件类型，见下表）"
}
```

Webhook 请求：

```
POST <你的回调URL>
Content-Type: application/json
X-LVS-Event: <事件类型>
X-LVS-Signature: <hex(HMAC_SHA256(secret, 原始请求体))>

{ "type": "...", "time": "...", ...payload }   // 无 scope 字段，其余与 WS 相同
```

### 事件类型与 payload 字段

视频 / 创作者（personal scope，推给视频主）：

| type | payload 字段 |
|---|---|
| `video.uploaded` | `videoId, title, status("pending"\|"approved")` |
| `video.review.approved` | `videoId, title` |
| `video.review.rejected` | `videoId, title, reason` |
| `video.taken_down` | `videoId, title, reason` |
| `video.comment.created` | `videoId, videoTitle, commentId, by(评论者用户名), content, parentId` |
| `report.resolved` | `reportId, action("resolved"\|"dismissed"), note, targetType, targetId` |
| `account.banned` | `banned_until(ISO8601), reason, hours` |

聊天（personal scope）：

| type | payload 字段 |
|---|---|
| `chat.message.new` | `conversationId, conversationType("system"\|"direct"), from?{id,username,nickname}(direct 才有), message{id, conversation_id, sender_id(null=系统), content(direct 为密文 base64), encrypted, iv, created_at}` |

直播间（room scope，进房后接收；同时推给主播 personal）：

| type | payload 字段 |
|---|---|
| `live.started` / `live.stopped` | `roomId, roomTitle, owner?；stopped 被断流时附 cut:true, reason` |
| `live.cut` | `roomId, roomTitle, reason` |
| `room.user.joined` / `room.user.left` | `roomId, userId(null=游客), username` |
| `chat.message` | `roomId, userId, username, content`（直播弹幕，区别于私聊 `chat.message.new`） |
| `mic.requested` | `roomId, micId, userId, username` |
| `mic.approved` | `roomId, micId, userId, username`；连麦者 personal 通道额外收到 `trtc{sdk_app_id, str_room_id, user_id, user_sig, role:"anchor"}` |
| `mic.rejected` | `roomId, micId, userId, username` |
| `mic.live` / `mic.ended` | `roomId, micId, userId, username, rtc_user_id` |

管理员（admin scope，仅管理员账号收到）：

| type | payload 字段 |
|---|---|
| `admin.video.uploaded` | `videoId, title, ownerId, ownerName, status, needReview` |
| `admin.report.created` | `reportId, targetType("video"\|"comment"), targetId, reason, reporter` |
| `admin.feedback.created` | `conversationId, messageId, userId, username, nickname, content`（用户向系统消息发送的反馈） |
| `admin.user.banned` | `userId, hours, reason` |
| `admin.live.started` / `admin.live.stopped` | `roomId, roomTitle, owner?` |
| `admin.chat.message` | `roomId, userId, username, content` |

系统消息推送：以上 `video.review.approved/rejected`、`video.taken_down`、`report.resolved`、`account.banned`、`video.comment.created` 发生时，服务端还会向用户的「系统消息」会话写入一条可读通知（即同时触发一条 `chat.message.new`）。

## 五、给 Agent 的提示

- 先 `GET /api/auth/me` 确认 Key 有效与角色（user/admin）。
- 上传大视频请用 multipart 流式上传，limit 4GB。
- 直播为「声明式状态」：OBS 推流不会自动标记开播，请在确认推流后调用 `live/start`。
- 任何 403/503 错误信息均为中文明确原因，请如实转告用户，不要重试绕过。
- 开发「插件」（监听事件 + 调 API 的常驻程序，如视频上传自动加字幕并过审）请阅读 `<前端url>/plugin.md`。
