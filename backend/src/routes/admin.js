'use strict';
// 管理员：审核/下架/封禁/断流/举报处理/站点设置/全量视图
const express = require('express');
const db = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { emitToUser, emitToAdmins, emitRoomEvent } = require('../lib/events');
const { sendSystemMessage } = require('../lib/chat');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ---- 站点设置：免审模式 ----
router.get('/settings', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT key, value FROM site_settings');
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (e) { next(e); }
});

router.put('/settings/review_required', async (req, res, next) => {
  try {
    const value = !!(req.body && req.body.value);
    await db.query(
      `INSERT INTO site_settings (key, value) VALUES ('review_required', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(value)]);
    res.json({ review_required: value });
  } catch (e) { next(e); }
});

// ---- 视频审核 ----
router.get('/videos', async (req, res, next) => {
  try {
    const status = req.query.status; // pending/approved/...
    const params = [];
    let where = 'TRUE';
    if (status) { params.push(status); where = `v.status = $1`; }
    const { rows } = await db.query(
      `SELECT v.*, u.username AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id
       WHERE ${where} ORDER BY v.created_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/videos/:id/approve', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE videos SET status = 'approved', reject_reason = NULL WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await emitToUser(rows[0].owner_id, 'video.review.approved', { videoId: rows[0].id, title: rows[0].title });
    await sendSystemMessage(rows[0].owner_id, `你的视频《${rows[0].title}》已通过审核并上架`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post('/videos/:id/reject', async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason) || '未通过审核';
    const { rows } = await db.query(
      `UPDATE videos SET status = 'rejected', reject_reason = $1 WHERE id = $2 RETURNING *`,
      [reason, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await emitToUser(rows[0].owner_id, 'video.review.rejected', { videoId: rows[0].id, title: rows[0].title, reason });
    await sendSystemMessage(rows[0].owner_id, `你的视频《${rows[0].title}》未通过审核：${reason}`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// 审核 API：下架视频（传入视频 id 和下架理由）
router.post('/videos/:id/takedown', async (req, res, next) => {
  try {
    const reason = (req.body && req.body.reason);
    if (!reason) return res.status(400).json({ error: 'reason 必填' });
    const { rows } = await db.query(
      `UPDATE videos SET status = 'taken_down', takedown_reason = $1 WHERE id = $2 RETURNING *`,
      [reason, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await emitToUser(rows[0].owner_id, 'video.taken_down', { videoId: rows[0].id, title: rows[0].title, reason });
    await sendSystemMessage(rows[0].owner_id, `你的视频《${rows[0].title}》已被下架：${reason}`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---- 直播间管理 ----
router.get('/rooms', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, u.username AS owner_name FROM live_rooms r JOIN users u ON u.id = r.owner_id
       ORDER BY r.is_live DESC, r.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { next(e); }
});

// 审核 API：断流直播间（TRTC 模式为协同断流：标记下播 + 广播 live.cut，
// 本站前端收到后立即退出 TRTC 房间停止推/拉流；不依赖腾讯云服务端踢人 REST API）
router.post('/rooms/:id/cut', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, u.username AS owner_name FROM live_rooms r JOIN users u ON u.id = r.owner_id WHERE r.id = $1`,
      [req.params.id]);
    const room = rows[0];
    if (!room) return res.status(404).json({ error: 'room not found' });
    const reason = (req.body && req.body.reason) || null;
    await db.query(`UPDATE live_rooms SET is_live = false WHERE id = $1`, [room.id]);
    await db.query(`UPDATE mic_sessions SET status = 'ended', updated_at = now()
                    WHERE room_id = $1 AND status IN ('requested','approved','live')`, [room.id]);
    await emitRoomEvent(room, 'live.cut', { roomTitle: room.title, reason });
    await emitRoomEvent(room, 'live.stopped', { roomTitle: room.title, cut: true, reason });
    await emitToUser(room.owner_id, 'live.cut', { roomId: room.id, reason });
    res.json({ ok: true, reason });
  } catch (e) { next(e); }
});

// ---- 用户管理 / 封禁 ----
router.get('/users', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const { rows } = await db.query(
      `SELECT id, username, email, role, banned_until, ban_reason, created_at FROM users
       WHERE username ILIKE $1 ORDER BY id DESC LIMIT 200`, [q]);
    res.json(rows);
  } catch (e) { next(e); }
});

// 封禁一定时段（body: { hours, reason }；hours=0 解除封禁）
router.post('/users/:id/ban', async (req, res, next) => {
  try {
    const hours = Number((req.body && req.body.hours) ?? 24);
    const reason = (req.body && req.body.reason) || '违反社区规定';
    if (Number.isNaN(hours) || hours < 0) return res.status(400).json({ error: 'hours 非法' });
    const target = (await db.query('SELECT id, role FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ error: 'user not found' });
    if (target.role === 'admin') return res.status(400).json({ error: '不能封禁管理员' });

    if (hours === 0) {
      await db.query('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = $1', [target.id]);
      return res.json({ ok: true, unbanned: true });
    }
    const { rows } = await db.query(
      `UPDATE users SET banned_until = now() + ($1 || ' hours')::interval, ban_reason = $2
       WHERE id = $3 RETURNING banned_until`, [String(hours), reason, target.id]);
    await emitToUser(target.id, 'account.banned', { banned_until: rows[0].banned_until, reason, hours });
    await sendSystemMessage(target.id,
      `你的账号已被封禁至 ${new Date(rows[0].banned_until).toLocaleString('zh-CN')}，原因：${reason}`);
    await emitToAdmins('admin.user.banned', { userId: target.id, hours, reason });
    res.json({ ok: true, banned_until: rows[0].banned_until });
  } catch (e) { next(e); }
});

// ---- 举报处理 ----
router.get('/reports', async (req, res, next) => {
  try {
    const status = req.query.status || 'open';
    const { rows } = await db.query(
      `SELECT r.*, u.username AS reporter_name FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE r.status = $1 ORDER BY r.id DESC LIMIT 200`, [status]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/reports/:id/resolve', async (req, res, next) => {
  try {
    const { action = 'resolved', note = '' } = req.body || {};
    if (!['resolved', 'dismissed'].includes(action)) return res.status(400).json({ error: 'action 必须是 resolved/dismissed' });
    const { rows } = await db.query(
      `UPDATE reports SET status = $1, resolved_by = $2, resolution_note = $3 WHERE id = $4 RETURNING *`,
      [action, req.user.id, note, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await emitToUser(rows[0].reporter_id, 'report.resolved', {
      reportId: rows[0].id, action, note, targetType: rows[0].target_type, targetId: rows[0].target_id
    });
    await sendSystemMessage(rows[0].reporter_id, action === 'resolved'
      ? `你的举报（#${rows[0].id}）已受理并处理完成${note ? `：${note}` : ''}`
      : `你的举报（#${rows[0].id}）经核实暂不处理${note ? `：${note}` : ''}`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---- 用户反馈（系统消息会话中用户发送的内容）----
router.get('/feedback', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const { rows } = await db.query(
      `SELECT m.id, m.conversation_id, m.content, m.created_at,
              u.id AS user_id, u.username, u.nickname
       FROM chat_messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.type = 'system'
       JOIN users u ON u.id = m.sender_id
       ORDER BY m.id DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (e) { next(e); }
});

// 回复某用户的反馈（写入其系统消息会话）body: { content }
router.post('/feedback/:userId/reply', async (req, res, next) => {
  try {
    const content = (req.body && req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content 必填' });
    const u = await db.query('SELECT id FROM users WHERE id = $1', [req.params.userId]);
    if (!u.rows[0]) return res.status(404).json({ error: 'user not found' });
    const message = await sendSystemMessage(u.rows[0].id, `[管理员回复] ${content}`);
    res.status(201).json(message);
  } catch (e) { next(e); }
});

// 管理员事件历史（admin 广播事件 user_id 为 NULL）
router.get('/events', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const { rows } = await db.query(
      `SELECT id, type, payload, created_at FROM events WHERE user_id IS NULL ORDER BY id DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
