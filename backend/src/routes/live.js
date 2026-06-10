'use strict';
// 直播间：创建/信息(含 TRTC 进房与推流参数)/密码/黑名单/连麦/自定义回调
// 直播与连麦基于腾讯云 TRTC：
// - 房间号：直播间 stream_key 作为 TRTC 字符串房间号（strRoomId）
// - 主播：网页端以 anchor 进房推流，或 OBS 经「RTMP 推流进房」
// - 观众：以 audience 进房订阅主播与连麦者的画面
// - 连麦：观众申请 → 主播同意 → 观众 switchRole 为 anchor 发布 → 通知后端进入 live 状态
const express = require('express');
const crypto = require('crypto');
const db = require('../db/pool');
const { enterRoomParams, rtmpPush, rtcUserId, obsUserId, trtcEnabled } = require('../lib/trtc');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { emitRoomEvent, emitToUser, emitToAdmins } = require('../lib/events');

const router = express.Router();

async function getRoom(id) {
  const { rows } = await db.query(
    `SELECT r.*, u.username AS owner_name FROM live_rooms r JOIN users u ON u.id = r.owner_id WHERE r.id = $1`, [id]);
  return rows[0] || null;
}

function isOwner(room, user) {
  return user && (user.id === room.owner_id || user.role === 'admin');
}

async function isBlacklisted(roomId, userId) {
  if (!userId) return false;
  const { rows } = await db.query('SELECT 1 FROM room_blacklist WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  return !!rows[0];
}

async function checkRoomAccess(room, user, password) {
  if (isOwner(room, user)) return { ok: true };
  if (user && await isBlacklisted(room.id, user.id)) return { ok: false, reason: 'blacklisted' };
  if (room.password && room.password !== (password || '')) return { ok: false, reason: 'password' };
  return { ok: true };
}

function roomPublic(room, withSecrets = false) {
  const base = {
    id: room.id, title: room.title, description: room.description,
    owner_id: room.owner_id, owner_name: room.owner_name,
    is_live: room.is_live, live_started_at: room.live_started_at,
    has_password: !!room.password, created_at: room.created_at
  };
  if (withSecrets) {
    base.stream_key = room.stream_key;
    base.password = room.password;
    if (trtcEnabled()) {
      base.publish = {
        trtc: enterRoomParams(room.stream_key, room.owner_id, 'anchor'), // 网页端开播进房参数
        rtmp: rtmpPush(room.stream_key, room.owner_id)                   // OBS RTMP 推流进房
      };
    } else {
      base.publish = null;
      base.trtc_error = 'TRTC 未配置：请在 .env 中设置 TRTC_SDK_APP_ID 与 TRTC_SECRET_KEY 后重启服务';
    }
  }
  return base;
}

// 当前在麦（live）的连麦成员
async function liveMics(roomId) {
  const { rows } = await db.query(
    `SELECT m.id, m.user_id, u.username FROM mic_sessions m
     JOIN users u ON u.id = m.user_id WHERE m.room_id = $1 AND m.status = 'live'`, [roomId]);
  return rows.map((m) => ({ micId: m.id, userId: m.user_id, username: m.username, rtc_user_id: rtcUserId(m.user_id) }));
}

// 直播间列表
router.get('/rooms', optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, u.username AS owner_name FROM live_rooms r JOIN users u ON u.id = r.owner_id
       ORDER BY r.is_live DESC, r.created_at DESC LIMIT 100`);
    res.json(rows.map((r) => roomPublic(r, req.user && (req.user.id === r.owner_id || req.user.role === 'admin'))));
  } catch (e) { next(e); }
});

// 创建直播间
router.post('/rooms', requireAuth, async (req, res, next) => {
  try {
    const { title, description = '', password = null } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title 必填' });
    const streamKey = 'live_' + crypto.randomBytes(12).toString('hex');
    const { rows } = await db.query(
      `INSERT INTO live_rooms (owner_id, title, description, stream_key, password)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, title.slice(0, 200), description.slice(0, 2000), streamKey, password || null]);
    res.status(201).json(roomPublic({ ...rows[0], owner_name: req.user.username }, true));
  } catch (e) { next(e); }
});

// 直播间信息（主播/管理员可见推流参数与密码）
router.get('/rooms/:id', optionalAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    res.json(roomPublic(room, isOwner(room, req.user)));
  } catch (e) { next(e); }
});

// 修改直播间（标题/简介/密码；密码传空字符串则取消）
router.patch('/rooms/:id', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (!isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { title, description, password } = req.body || {};
    const newPassword = password === undefined ? room.password : (password === '' ? null : password);
    const { rows } = await db.query(
      `UPDATE live_rooms SET title = COALESCE($1, title), description = COALESCE($2, description), password = $3
       WHERE id = $4 RETURNING *`, [title, description, newPassword, room.id]);
    res.json(roomPublic({ ...rows[0], owner_name: room.owner_name }, true));
  } catch (e) { next(e); }
});

// 观众获取观看参数（校验密码与黑名单）：以 audience 进 TRTC 房间订阅画面
router.post('/rooms/:id/watch', optionalAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const access = await checkRoomAccess(room, req.user, req.body && req.body.password);
    if (!access.ok) {
      return res.status(403).json({ error: access.reason === 'blacklisted' ? '你已被该直播间拉黑' : '直播间密码错误', reason: access.reason });
    }
    // 匿名观众也允许观看：TRTC userId 用随机 guest id（不与登录用户冲突）
    const viewerId = req.user ? req.user.id : `guest_${crypto.randomBytes(6).toString('hex')}`;
    const role = isOwner(room, req.user) ? 'anchor' : 'audience';
    res.json({
      room: roomPublic(room),
      // TRTC 未配置时不中断观看页（聊天仍可用），但给出明确错误而非降级
      trtc: trtcEnabled() ? enterRoomParams(room.stream_key, viewerId, role) : null,
      trtc_error: trtcEnabled() ? null : 'TRTC 未配置：请在 .env 中设置 TRTC_SDK_APP_ID 与 TRTC_SECRET_KEY 后重启服务',
      // 主播在 TRTC 房间内可能的两个身份：网页端 u<id> / OBS 推流 obs<id>
      anchor_user_ids: [rtcUserId(room.owner_id), obsUserId(room.owner_id)],
      mic_streams: await liveMics(room.id)
    });
  } catch (e) { next(e); }
});

// 推流参数（API：主播/管理员获取 TRTC 进房参数与 OBS RTMP 推流地址）
router.get('/rooms/:id/stream-urls', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (!isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    res.json({
      stream_key: room.stream_key,
      is_live: room.is_live,
      trtc: enterRoomParams(room.stream_key, room.owner_id, 'anchor'),
      rtmp_push: rtmpPush(room.stream_key, room.owner_id)
    });
  } catch (e) { next(e); }
});

// ---- 开播 / 下播（主播声明直播状态；TRTC 无本地回调，状态由主播端上报） ----
router.post('/rooms/:id/live/start', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (!isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const owner = (await db.query('SELECT banned_until FROM users WHERE id = $1', [room.owner_id])).rows[0];
    if (owner.banned_until && new Date(owner.banned_until) > new Date()) {
      return res.status(403).json({ error: '账号封禁中，无法开播' });
    }
    await db.query(`UPDATE live_rooms SET is_live = true, live_started_at = now() WHERE id = $1`, [room.id]);
    await emitRoomEvent(room, 'live.started', { roomTitle: room.title, owner: room.owner_name });
    await emitToAdmins('admin.live.started', { roomId: room.id, roomTitle: room.title, owner: room.owner_name });
    res.json({ ok: true, is_live: true });
  } catch (e) { next(e); }
});

router.post('/rooms/:id/live/stop', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (!isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    await db.query(`UPDATE live_rooms SET is_live = false WHERE id = $1`, [room.id]);
    await db.query(`UPDATE mic_sessions SET status = 'ended', updated_at = now()
                    WHERE room_id = $1 AND status IN ('requested','approved','live')`, [room.id]);
    await emitRoomEvent(room, 'live.stopped', { roomTitle: room.title });
    await emitToAdmins('admin.live.stopped', { roomId: room.id, roomTitle: room.title });
    res.json({ ok: true, is_live: false });
  } catch (e) { next(e); }
});

// ---- 黑名单 ----
router.get('/rooms/:id/blacklist', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { rows } = await db.query(
      `SELECT b.user_id, u.username, b.created_at FROM room_blacklist b
       JOIN users u ON u.id = b.user_id WHERE b.room_id = $1`, [room.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/rooms/:id/blacklist', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { user_id, username } = req.body || {};
    let targetId = user_id;
    if (!targetId && username) {
      const u = await db.query('SELECT id FROM users WHERE username = $1', [username]);
      targetId = u.rows[0] && u.rows[0].id;
    }
    if (!targetId) return res.status(400).json({ error: '需要 user_id 或 username' });
    await db.query(
      `INSERT INTO room_blacklist (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [room.id, targetId]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/rooms/:id/blacklist/:userId', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    await db.query('DELETE FROM room_blacklist WHERE room_id = $1 AND user_id = $2', [room.id, req.params.userId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 连麦（TRTC 同房连麦：观众 switchRole 为 anchor 发布音视频） ----
// 观众发起连麦请求
router.post('/rooms/:id/mic/request', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (!room.is_live) return res.status(400).json({ error: '直播未开始' });
    const access = await checkRoomAccess(room, req.user, req.body && req.body.password);
    if (!access.ok) return res.status(403).json({ error: '无权进入该直播间' });
    const streamName = `mic_${crypto.randomBytes(8).toString('hex')}`; // 历史字段，保持唯一即可
    const { rows } = await db.query(
      `INSERT INTO mic_sessions (room_id, user_id, stream_name) VALUES ($1,$2,$3) RETURNING *`,
      [room.id, req.user.id, streamName]);
    await emitRoomEvent(room, 'mic.requested', {
      micId: rows[0].id, userId: req.user.id, username: req.user.username
    });
    res.status(201).json({ micId: rows[0].id, status: 'requested' });
  } catch (e) { next(e); }
});

// 主播同意/拒绝连麦
router.post('/rooms/:id/mic/:micId/decision', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const approve = !!(req.body && req.body.approve);
    const { rows } = await db.query(
      `UPDATE mic_sessions SET status = $1, updated_at = now()
       WHERE id = $2 AND room_id = $3 AND status = 'requested' RETURNING *`,
      [approve ? 'approved' : 'rejected', req.params.micId, room.id]);
    const mic = rows[0];
    if (!mic) return res.status(404).json({ error: 'mic request not found or already handled' });
    const guest = (await db.query('SELECT username FROM users WHERE id = $1', [mic.user_id])).rows[0];
    if (approve) {
      await emitRoomEvent(room, 'mic.approved', { micId: mic.id, userId: mic.user_id, username: guest.username });
      // 私信连麦者 TRTC anchor 进房参数（网页端已在房内的只需 switchRole；API/Agent 用户可用该参数直接进房发布）
      await emitToUser(mic.user_id, 'mic.approved', {
        micId: mic.id, roomId: room.id,
        trtc: enterRoomParams(room.stream_key, mic.user_id, 'anchor')
      });
    } else {
      await emitRoomEvent(room, 'mic.rejected', { micId: mic.id, userId: mic.user_id, username: guest.username });
      await emitToUser(mic.user_id, 'mic.rejected', { micId: mic.id, roomId: room.id });
    }
    res.json({ ok: true, status: approve ? 'approved' : 'rejected' });
  } catch (e) { next(e); }
});

// 连麦者发布成功后上报（进入 live 状态，广播给全房间订阅）
router.post('/rooms/:id/mic/:micId/live', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const { rows } = await db.query(
      `UPDATE mic_sessions SET status = 'live', updated_at = now()
       WHERE id = $1 AND room_id = $2 AND user_id = $3 AND status = 'approved' RETURNING *`,
      [req.params.micId, room.id, req.user.id]);
    const mic = rows[0];
    if (!mic) return res.status(404).json({ error: 'mic session not found or not approved' });
    await emitRoomEvent(room, 'mic.live', {
      micId: mic.id, userId: mic.user_id, username: req.user.username, rtc_user_id: rtcUserId(mic.user_id)
    });
    res.json({ ok: true, status: 'live' });
  } catch (e) { next(e); }
});

// 结束连麦（主播或连麦者本人；连麦者客户端收到 mic.ended 后退回 audience 角色）
router.post('/rooms/:id/mic/:micId/end', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const { rows } = await db.query('SELECT * FROM mic_sessions WHERE id = $1 AND room_id = $2',
      [req.params.micId, room.id]);
    const mic = rows[0];
    if (!mic) return res.status(404).json({ error: 'not found' });
    if (!isOwner(room, req.user) && mic.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    await db.query(`UPDATE mic_sessions SET status = 'ended', updated_at = now() WHERE id = $1`, [mic.id]);
    const guest = (await db.query('SELECT username FROM users WHERE id = $1', [mic.user_id])).rows[0];
    await emitRoomEvent(room, 'mic.ended', {
      micId: mic.id, userId: mic.user_id, username: guest.username, rtc_user_id: rtcUserId(mic.user_id)
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 连麦请求列表（主播）
router.get('/rooms/:id/mic', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { rows } = await db.query(
      `SELECT m.*, u.username FROM mic_sessions m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = $1 AND m.status IN ('requested','approved','live') ORDER BY m.created_at`, [room.id]);
    res.json(rows.map((m) => ({ ...m, rtc_user_id: rtcUserId(m.user_id) })));
  } catch (e) { next(e); }
});

// ---- 历史录制文件（只读；TRTC 模式下服务端录制已移除，如需录制请使用腾讯云云端录制） ----
router.get('/rooms/:id/recordings', requireAuth, async (req, res, next) => {
  try {
    const config = require('../config');
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { rows } = await db.query(
      'SELECT * FROM recordings WHERE room_id = $1 ORDER BY started_at DESC LIMIT 100', [room.id]);
    res.json(rows.map((r) => ({
      ...r,
      url: r.object_key ? `${config.publicBaseUrl}/storage/${config.buckets.recordings}/${r.object_key}` : null
    })));
  } catch (e) { next(e); }
});

// ---- 直播间自定义事件回调（主播设置区） ----
router.get('/rooms/:id/webhooks', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { rows } = await db.query('SELECT * FROM room_webhooks WHERE room_id = $1 ORDER BY id', [room.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/rooms/:id/webhooks', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    const { url, secret = '', events = [] } = req.body || {};
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url 必须是 http(s) 地址' });
    const { rows } = await db.query(
      'INSERT INTO room_webhooks (room_id, url, secret, events) VALUES ($1,$2,$3,$4) RETURNING *',
      [room.id, url, secret, events]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.delete('/rooms/:id/webhooks/:whId', requireAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room || !isOwner(room, req.user)) return res.status(403).json({ error: 'forbidden' });
    await db.query('DELETE FROM room_webhooks WHERE id = $1 AND room_id = $2', [req.params.whId, room.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 聊天历史
router.get('/rooms/:id/messages', optionalAuth, async (req, res, next) => {
  try {
    const room = await getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const { rows } = await db.query(
      `SELECT m.id, m.content, m.created_at, u.id AS user_id, u.username FROM live_messages m
       JOIN users u ON u.id = m.user_id WHERE m.room_id = $1 ORDER BY m.id DESC LIMIT 50`, [room.id]);
    res.json(rows.reverse());
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.getRoom = getRoom;
module.exports.checkRoomAccess = checkRoomAccess;
module.exports.isBlacklisted = isBlacklisted;
