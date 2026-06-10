-- LAN Video Station schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  bio           TEXT DEFAULT '',
  banned_until  TIMESTAMPTZ,
  ban_reason    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token      TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS videos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  object_key      TEXT NOT NULL,
  thumbnail_key   TEXT,
  mime            TEXT DEFAULT 'video/mp4',
  size_bytes      BIGINT DEFAULT 0,
  duration_sec    REAL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','taken_down')),
  reject_reason   TEXT,
  takedown_reason TEXT,
  views           BIGINT DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos(owner_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status, visibility);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS unlock_password TEXT; -- 明文存储仅限局域网场景；私有视频可凭密码解锁观看

-- 私有视频白名单（用户名加入后可直接观看）
CREATE TABLE IF NOT EXISTS video_whitelist (
  video_id   UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, user_id)
);

-- 视频收藏夹（公开收藏夹可通过链接分享）
CREATE TABLE IF NOT EXISTS collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_id);

CREATE TABLE IF NOT EXISTS collection_videos (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  video_id      UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position      SERIAL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, video_id)
);

CREATE TABLE IF NOT EXISTS subtitles (
  id          SERIAL PRIMARY KEY,
  video_id    UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  uploader_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang        TEXT NOT NULL DEFAULT 'zh',
  label       TEXT NOT NULL DEFAULT '中文',
  format      TEXT NOT NULL DEFAULT 'vtt',
  object_key  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  video_id   UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  INT REFERENCES comments(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);

CREATE TABLE IF NOT EXISTS reports (
  id              SERIAL PRIMARY KEY,
  reporter_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type     TEXT NOT NULL CHECK (target_type IN ('video','comment')),
  target_id       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by     INT REFERENCES users(id),
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  stream_key      TEXT UNIQUE NOT NULL,
  password        TEXT,                -- 明文存储仅限局域网场景；为空则公开
  is_live         BOOLEAN NOT NULL DEFAULT false,
  live_started_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_blacklist (
  room_id    UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS mic_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','live','ended')),
  stream_name TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  started_by INT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','stored','failed')),
  object_key TEXT,
  size_bytes BIGINT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS live_messages (
  id         SERIAL PRIMARY KEY,
  room_id    UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_live_messages_room ON live_messages(room_id);

-- 用户级 webhook（按事件类型订阅）
CREATE TABLE IF NOT EXISTS user_webhooks (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  secret     TEXT DEFAULT '',
  events     TEXT[] NOT NULL DEFAULT '{}',  -- 空数组 = 订阅全部
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 直播间自定义事件回调（主播在直播设置区配置）
CREATE TABLE IF NOT EXISTS room_webhooks (
  id         SERIAL PRIMARY KEY,
  room_id    UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  secret     TEXT DEFAULT '',
  events     TEXT[] NOT NULL DEFAULT '{}',
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cdn_nodes (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  base_url   TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 节点类型：仅支持 public（公网 CDN，如腾讯云/Cloudflare，手动配置，可达性探测）。
-- 私有（局域网自建 edge）CDN 已移除：历史 edge 节点在迁移时清理。
ALTER TABLE cdn_nodes ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'public' CHECK (type IN ('edge','public'));
ALTER TABLE cdn_nodes ALTER COLUMN type SET DEFAULT 'public';
DELETE FROM cdn_nodes WHERE type = 'edge';

CREATE TABLE IF NOT EXISTS site_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
INSERT INTO site_settings(key, value) VALUES ('review_required', 'true')
  ON CONFLICT (key) DO NOTHING;

-- 事件存档（审计 / 调试 / 拉取历史）
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  user_id    INT,            -- 事件接收者（NULL = 管理员广播）
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id DESC);
