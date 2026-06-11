# LAN Video Station — 局域网全栈视频站

视频点播 + 直播连麦（腾讯云 TRTC）+ 开放 API/Webhook + 公网 CDN 调度，Docker Compose 一键部署。

技术栈：Node.js (Express) · Vue 3 (Vite) · PostgreSQL · Redis · MinIO（视频存储）· 腾讯云 TRTC（直播/连麦）· Nginx（网关）

## 快速开始

```bash
cp .env.example .env
# 必改（局域网部署）：LAN_IP 设为宿主机的局域网 IP（播放/下载直链依赖它）
# 必改（公网域名部署）：若通过公网域名访问，请直接在 .env 中配置 PUBLIC_BASE_URL（如 https://yourdomain.com），此时无需配置 LAN_IP
# 必改：TRTC_SDK_APP_ID / TRTC_SECRET_KEY（腾讯云 TRTC 控制台创建应用获取，直播/连麦必需）
# 可改：WEB_HTTP_PORT / WEB_HTTPS_PORT（nginx 对外服务总端口，默认 80/443）
docker compose up -d --build
# 提示：构建后端 Docker 镜像时，已配置使用中科大镜像源 (mirrors.ustc.edu.cn) 加速 Alpine apk 包 (ffmpeg) 的下载。
```

| 入口 | 地址 |
|---|---|
| 站点（电脑/手机浏览器） | http://LAN_IP:WEB_HTTP_PORT |
| 站点 HTTPS（网页开播/连麦必须） | https://LAN_IP:WEB_HTTPS_PORT |
| MinIO 控制台 | http://LAN_IP:9001 |
| OBS RTMP 推流（TRTC 推流进房） | 主播控制台复制服务器/推流码 |
| Agent 接口说明 | http://LAN_IP:WEB_HTTP_PORT/agents.md |

默认管理员：`.env` 中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（默认 admin / admin12345）。

## 功能

**视频**：注册/登录、上传（自动取时长 + 生成缩略图，存 MinIO）、播放（公开/私有）、评论与回复、字幕（vtt/srt 上传，srt 自动转 vtt）、举报视频与评论、下载直链。

**私有视频解锁**：私有视频默认仅自己可见；视频主可设置「解锁密码」（观众凭密码观看）或将用户名加入白名单（白名单用户登录后直接观看）。上传时可设密码，视频页（视频主可见）可改密码/管理白名单。

**收藏夹**：创建/分享视频收藏夹（公开收藏夹复制链接即可分享，他人无法看到的私有视频在列表中以 🔒 锁定占位显示）；从收藏夹打开视频后，右侧显示收藏夹内全部视频可连续切换；上传发布时可选择已有收藏夹自动加入；视频页「⭐ 收藏」可随时加入/新建收藏夹。

**审核**：管理后台可切换「免审模式」。开审核时公开视频需管理员通过才上架；管理员可以理由下架视频（触发 `video.taken_down` 事件）、封禁用户一定时长（小时，触发 `account.banned`）。

**直播（腾讯云 TRTC）**：
- 房间模型：直播间 `stream_key` 即 TRTC 字符串房间号（strRoomId）；主播 anchor、观众 audience 同房，UserSig 由后端按官方 TLS-Sig-API-v2（HMAC-SHA256）签发。
- 推流：网页开播（摄像头/屏幕共享，trtc-sdk-v5）或 OBS/FFmpeg「RTMP 推流进房」（需开通腾讯云 RTC-Engine 基础版/专业版套餐；推流后在控制台点「标记开播」）。
- 观看：观众以 audience 角色进 TRTC 房间订阅主播画面（超低延迟，无需 FLV/HLS）。
- 聊天：WebSocket 实时聊天 + 进出房提示（自建信令，不走 TRTC）。
- 连麦：观众申请 → 主播同意（连麦管理列表或右下角弹窗）→ 观众 switchRole 为 anchor 发布音视频 → 全员可见连麦小窗；主播或本人可随时结束（收到 `mic.ended` 事件后连麦端退回 audience）。
- 直播间密码、用户黑名单（设置区配置，发言/进房/连麦均校验）。
- 管理员断流：标记下播 + 广播 `live.cut`，本站前端（主播/观众）收到后立即退出 TRTC 房间（协同断流，不调用腾讯云服务端踢人 API）。
- 录制：原 SRS 服务端录制已移除；历史录制文件仍可在 API 查询/下载。如需录制请使用腾讯云 TRTC 云端录制。

**个人资料**：设置页可修改显示昵称（站内评论/聊天展示，留空回退用户名）与登录密码（旧密码 + 新密码 + 确认）。

**聊天（端到端加密）**：导航「消息」进入聊天页。
- 私聊：ECDH(P-256) 协商共享密钥 + AES-256-GCM 端到端加密，私钥仅存于浏览器 localStorage，服务器只保存公钥与密文（换浏览器/清缓存后历史消息不可解密，局域网场景取舍）。
- 系统消息：每个用户默认有一个「系统消息」会话，接收站点通知（视频审核结果、举报受理、视频下架、账号封禁、新评论）；用户向该会话发送的内容作为**反馈**直达管理员（实时 WebSocket 事件 `admin.feedback.created`，后台「用户反馈」标签页可查看/回复，亦可 `GET /api/admin/feedback` 查询）。
- 新消息会在右下角弹窗提醒（可点「不再弹窗」或在设置页开关）。

**开发者中心**：导航「开发者」页指导通过 API + WebSocket/Webhook 事件开发插件（如「视频上传自动添加字幕并审核」），并提供一键让 Claude 开发插件的入口；面向 Agent 的插件指南托管于 `/plugin.md`。

**CDN（仅公网 CDN）**：管理后台可添加公网 CDN 节点（腾讯云 CDN / Cloudflare 等）：将 CDN 源站指向本站（回源 `/storage/` 路径），在管理后台填写其访问域名（如 `https://cdn.example.com`）。点播播放在启用节点间轮询调度，`?cdn=off` 强制回源；健康检查为根路径可达性探测。局域网自建 cdn-edge 边缘节点已移除。

**Agent 接入**：`/agents.md` 提供面向 AI Agent 的全量接口说明（按管理员/主播/普通用户分节）；「个人设置」页一键生成发给 Agent 的提示词（含站点地址与 API Key 占位）。

## 开放 API

认证二选一：`Authorization: Bearer <JWT>` 或 `X-API-Key: lvs_xxx`（设置页创建，全功能）。
完整接口说明见站点 `/agents.md`。常用：

```
POST /api/auth/register|login          注册/登录
GET  /api/videos?q=                    公开视频列表
POST /api/videos                       上传（multipart: file,title,visibility）
GET  /api/videos/:id/play              播放/下载直链（可经公网 CDN；私有视频可带 ?password=）
GET|POST /api/videos/:id/whitelist     私有视频白名单（视频主）/ 添加 {username}
GET|POST /api/videos/:id/comments      评论列表 / 评论与回复(parent_id)
GET|POST /api/videos/:id/subtitles     字幕列表 / 添加字幕
GET  /api/collections/mine             我的收藏夹
POST /api/live/rooms                   创建直播间
GET  /api/live/rooms/:id/stream-urls   TRTC 进房参数 + OBS RTMP 推流地址
POST /api/live/rooms/:id/watch         观众取 TRTC 观看参数（密码/黑名单校验）
POST /api/live/rooms/:id/live/start|stop  标记开播/下播
POST /api/live/rooms/:id/mic/request   申请连麦
POST /api/live/rooms/:id/mic/:micId/decision   主播同意/拒绝 {approve}
POST /api/live/rooms/:id/mic/:micId/live       连麦者发布成功上报
GET|POST /api/me/webhooks              个人 Webhook 配置
# 管理员
POST /api/admin/videos/:id/takedown    审核 API 下架 {reason}
POST /api/admin/rooms/:id/cut          审核 API 断流（协同断流）
POST /api/admin/users/:id/ban          封禁 {hours, reason}（hours=0 解封）
PUT  /api/admin/settings/review_required  免审开关
GET|POST|PATCH|DELETE /api/cdn/nodes   公网 CDN 节点管理
```

## 事件推送（WebSocket / Webhook）

- WebSocket：`ws://站点/ws?token=<JWT 或 API Key>`，连接即收个人事件；发送 `{"type":"join","roomId":"...","password":"..."}` 收直播间事件，发送 `{"type":"chat","roomId":"...","content":"..."}` 发弹幕。管理员连接自动收全站事件。
- Webhook：设置页（个人）或主播控制台（直播间）配置 URL/密钥/事件过滤；POST JSON，头部 `X-LVS-Event`（类型）与 `X-LVS-Signature`（HMAC-SHA256 签名）。

| 角色 | 事件 |
|---|---|
| 创作者 | video.uploaded, video.review.approved/rejected, video.taken_down, video.comment.created, report.resolved, account.banned |
| 聊天 | chat.message.new（系统通知/私聊新消息，私聊 content 为密文） |
| 主播/直播间 | live.started, live.stopped, live.cut, room.user.joined/left, chat.message, mic.requested/approved/rejected/live/ended |
| 管理员 | admin.video.uploaded, admin.live.started/stopped, admin.chat.message, admin.report.created, admin.feedback.created, admin.user.banned |

各事件 payload 字段（schema）见站点 `/agents.md` 第四节；插件开发指南见 `/plugin.md`。

## 目录结构

```
backend/    Express API + WS 网关 + TRTC UserSig 签发
frontend/   Vue 3 SPA（trtc-sdk-v5）+ nginx 网关（/api /ws /storage 反代；/agents.md 静态托管）
```

## 网页开播 / 连麦必须用 HTTPS

浏览器只在安全上下文（HTTPS 或 localhost）暴露 `navigator.mediaDevices`，否则摄像头/屏幕采集不可用。本项目 nginx 同时监听 80 和 443（内置自签证书）：

1. 主播/连麦观众请访问 `https://LAN_IP:WEB_HTTPS_PORT`，首次访问浏览器会警告证书不受信任，点「高级 → 继续访问」即可；
2. 在 HTTP 页面点「开播/连麦」时，前端会自动提示并跳转 HTTPS；
3. 仅观看/聊天用 HTTP 即可。

## TRTC 接入说明与边界

- 需要腾讯云账号与 TRTC 应用（SDKAppID + SDKSecretKey），填入 `.env`。直播/连麦走腾讯云（产生用量计费），需要**外网连通**；点播/评论/聊天等其余功能仍为纯局域网。
- 未配置凭证时，直播/连麦相关接口返回明确错误（HTTP 503），不做本地降级。
- OBS「RTMP 推流进房」需在腾讯云开通 RTC-Engine 基础版/专业版套餐；推流进房仅支持字符串房间号，本站房间号即 `stream_key`。
- TRTC 服务端事件回调需公网可达地址，局域网部署收不到，因此开播/下播为主播端声明式上报（OBS 场景在控制台点「标记开播/下播」，或由 Agent 调 API）。
- 管理员断流为协同断流（站内事件驱动），第三方直接用 TRTC SDK 进房的客户端不受强制。

## 已知边界（局域网场景的取舍）

- 私有视频/未上架视频的对象 URL 为不可猜测的随机 key（MinIO 桶公共读 + nginx 反代），未走逐请求签名；如需更强隔离可改为 API 代理流式输出。
- 直播间密码、私有视频解锁密码明文存库（仅限内网使用场景）。
- **Let's Encrypt 证书验证**：为了支持通过 CDN（如腾讯云 EdgeOne）直连容器时申请 SSL 证书，已在 `docker-compose.yml` 中将宿主机 `/www/wwwroot/video.haiyanfl.cn/.well-known` 目录挂载至前端容器内。

