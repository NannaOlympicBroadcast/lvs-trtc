# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LAN Video Station (局域网全栈视频站) — a self-hosted video platform for LAN deployment: VOD (upload/review/playback/comments/subtitles), live streaming with co-streaming (连麦) powered by Tencent Cloud TRTC, open API/Webhooks, and public-CDN scheduling for VOD. UI text and code comments are in Chinese.

## Commands

```bash
# Full stack (the intended way to run everything; requires LAN_IP and TRTC credentials in .env)
cp .env.example .env
docker compose up -d --build

# Backend dev (needs postgres/redis/minio running, see backend/src/config.js for env defaults)
cd backend && npm install && npm run dev   # node --watch src/index.js

# Frontend dev
cd frontend && npm install && npm run dev  # vite
cd frontend && npm run build
```

There are no tests and no linter configured. Database migrations run automatically at backend startup ([backend/src/db/migrate.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/db/migrate.js) executes [backend/src/db/schema.sql](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/db/schema.sql), which must stay idempotent — use `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).

## Architecture

Docker Compose services in [docker-compose.yml](file:///d:/xiaoai-tongxue/lvs-trtc/docker-compose.yml): `postgres`, `redis`, `minio` (object storage: videos/thumbnails/subtitles/recordings buckets), `api` (Express backend), `web` (Vue 3 SPA + nginx gateway reverse-proxying `/api`, `/ws`, `/storage`; external ports configurable via `WEB_HTTP_PORT`/`WEB_HTTPS_PORT` in `.env`). There is no local media server: live streaming runs on Tencent Cloud TRTC.

### Live / co-streaming (TRTC)

- [backend/src/lib/trtc.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/lib/trtc.js) signs UserSig (TLS-Sig-API-v2, HMAC-SHA256) from `TRTC_SDK_APP_ID`/`TRTC_SECRET_KEY` env vars. When unconfigured, live APIs return explicit 503 errors — never mock or fall back.
- Room model: the live room's `stream_key` is the TRTC **string room id** (strRoomId). String ids are required because OBS "RTMP 推流进房" only supports string room ids and all clients must match. TRTC user ids: web `u<userId>`, OBS `obs<userId>`, anonymous viewers `uguest_<hex>`.
- Broadcaster publishes as `anchor` (web via trtc-sdk-v5, or OBS RTMP push-to-TRTC); viewers join as `audience` via `POST /api/live/rooms/:id/watch`. Co-streaming: guest requests → owner approves (`mic.approved` carries anchor params) → guest `switchRole(anchor)` + publish → guest reports `POST .../mic/:micId/live` → room event `mic.live` (carries `rtc_user_id`).
- Live state is declarative: `POST /api/live/rooms/:id/live/start|stop` (TRTC server callbacks need a public URL, unavailable on LAN). Admin cut (`/api/admin/rooms/:id/cut`) is cooperative: marks offline + broadcasts `live.cut`; this site's clients exit the TRTC room on receipt.
- Server-side recording was removed with SRS; `GET .../recordings` remains read-only for historical files.

### Backend ([backend/](file:///d:/xiaoai-tongxue/lvs-trtc/backend), Express, CommonJS)

- [backend/src/index.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/index.js) mounts all routes under `/api/*`; routers live in [backend/src/routes/](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/routes/). Nested routers (comments, subtitles) use `express.Router({ mergeParams: true })` and are mounted at `/api/videos/:videoId/...`.
- Auth ([backend/src/middleware/auth.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/middleware/auth.js)): dual-channel — JWT (`Authorization: Bearer`) or API key (`X-API-Key` / bearer token starting with `lvs_`). Use `requireAuth`, `optionalAuth` (sets `req.user` or null), `requireAdmin`. Bans are enforced in `requireAuth`.
- Video access control: `canSee(video, user)` in [backend/src/routes/videos.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/routes/videos.js) (exported and reused by comments/subtitles routes) — owner/admin always; otherwise must be `public` + `approved`. Private videos skip review; public videos are `pending` when the `review_required` site setting is on.
- Events ([backend/src/lib/events.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/lib/events.js)): every notable action emits events that fan out to WebSocket clients ([backend/src/ws/gateway.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/ws/gateway.js), Redis pub/sub based) and user/room webhooks, and are archived in the `events` table. Use `emitToUser`, `emitToAdmins`, `emitRoomEvent`.
- Media: uploads go through multer temp files → ffmpeg probe/thumbnail ([backend/src/lib/ffmpeg.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/lib/ffmpeg.js)) → MinIO ([backend/src/lib/minio.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/lib/minio.js), `objectUrl()` builds public URLs, optionally via a public CDN).
- CDN (public CDN only; self-hosted edge nodes removed): `pickEdge()` in [backend/src/routes/cdn.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/routes/cdn.js) round-robins enabled nodes for VOD playback; play endpoints accept `?cdn=off` to force origin. Live never goes through CDN.
- Config is centralized in [backend/src/config.js](file:///d:/xiaoai-tongxue/lvs-trtc/backend/src/config.js) (env vars with LAN-friendly defaults).

### Frontend ([frontend/](file:///d:/xiaoai-tongxue/lvs-trtc/frontend), Vue 3 + Vite + Pinia)

- [frontend/src/api.js](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/api.js): single `api()` fetch wrapper (auto-JWT, JSON errors, logs out on 401). Uploads needing progress use raw XHR instead (see [frontend/src/views/Upload.vue](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/views/Upload.vue)).
- [frontend/src/store.js](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/store.js): one Pinia auth store persisted to localStorage. [frontend/src/router.js](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/router.js) guards via `meta.auth` / `meta.admin`.
- [frontend/src/trtc.js](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/trtc.js) wraps trtc-sdk-v5 (`createTrtc`/`enterRoom`/`exitRoom`); [frontend/src/views/LiveRoom.vue](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/views/LiveRoom.vue) (audience + mic switchRole) and [frontend/src/views/Studio.vue](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/views/Studio.vue) (anchor publish, OBS push info, guest rendering) hold the live UX. TRTC renders into container `<div>`s passed as `view`.
- [frontend/public/agents.md](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/public/agents.md) is served at `/agents.md` — the agent-facing API reference (admin/broadcaster/user sections); [frontend/src/views/Settings.vue](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/views/Settings.vue) generates the copyable agent prompt. Keep it in sync when changing routes.
- [frontend/src/media.js](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/media.js) keeps capture helpers (`ensureCapture` HTTPS guard) and `mediaUrl` mixed-content rewriting for storage URLs; [frontend/src/ws.js](file:///d:/xiaoai-tongxue/lvs-trtc/frontend/src/ws.js) is the WebSocket event client.

### LAN-scenario security trade-offs (intentional, documented in README)

Object URLs are unguessable random keys but not per-request signed; live room passwords are stored in plaintext. Match this style when adding similar features rather than introducing heavyweight auth. TRTC credentials live only in backend env; UserSig expiry defaults to 7 days (`TRTC_SIG_EXPIRE`).
