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

注册/登录：

```
POST /api/auth/register        {username, password, email?}
POST /api/auth/login           {username, password} → {token}（JWT）
GET  /api/auth/me              当前用户信息
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
POST /api/admin/reports/:id/resolve            处理 {action: resolved|dismissed, note?}
GET  /api/admin/events?limit=                  管理员事件存档
GET|POST|PATCH|DELETE /api/cdn/nodes           公网 CDN 节点管理 {name, base_url}
POST /api/cdn/nodes/check                      节点健康检查
```

## 四、事件推送

- WebSocket：`ws(s)://站点/ws?token=<JWT 或 API Key>`。连接即收个人事件；发送 `{"type":"join","roomId":"...","password":"..."}` 进直播间收房间事件，`{"type":"chat","roomId":"...","content":"..."}` 发弹幕。管理员自动收全站事件。
- Webhook：POST JSON，头 `X-LVS-Event`（事件类型）与 `X-LVS-Signature`（HMAC-SHA256 签名，密钥为配置的 secret）。
- 常用事件：`video.uploaded`、`video.review.approved/rejected`、`video.taken_down`、`video.comment.created`、`account.banned`、`live.started`、`live.stopped`、`live.cut`、`chat.message`、`mic.requested/approved/rejected/live/ended`。

## 五、给 Agent 的提示

- 先 `GET /api/auth/me` 确认 Key 有效与角色（user/admin）。
- 上传大视频请用 multipart 流式上传，limit 4GB。
- 直播为「声明式状态」：OBS 推流不会自动标记开播，请在确认推流后调用 `live/start`。
- 任何 403/503 错误信息均为中文明确原因，请如实转告用户，不要重试绕过。
