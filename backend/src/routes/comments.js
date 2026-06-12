'use strict';
// 评论与回复（挂在 /api/videos/:videoId/comments）
const express = require('express');
const db = require('../db/pool');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { emitToUser } = require('../lib/events');
const { sendSystemMessage } = require('../lib/chat');
const { canAccess } = require('./videos');

const router = express.Router({ mergeParams: true });

async function getVisibleVideo(videoId, user, password) {
  const { rows } = await db.query('SELECT * FROM videos WHERE id = $1', [videoId]);
  const v = rows[0];
  if (!v || !(await canAccess(v, user, password))) return null;
  return v;
}

// 评论列表（含回复，扁平返回带 parent_id）
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const v = await getVisibleVideo(req.params.videoId, req.user, req.query.password);
    if (!v) return res.status(404).json({ error: 'video not found' });
    const { rows } = await db.query(
      `SELECT c.id, c.parent_id, c.content, c.created_at, c.deleted, u.id AS user_id, u.username,
              COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.video_id = $1 ORDER BY c.id ASC LIMIT 500`, [req.params.videoId]);
    res.json(rows.map((c) => c.deleted ? { ...c, content: '[已删除]' } : c));
  } catch (e) { next(e); }
});

// 发表评论 / 回复（body: content, parent_id 可选）
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const v = await getVisibleVideo(req.params.videoId, req.user, req.query.password);
    if (!v) return res.status(404).json({ error: 'video not found' });
    const { content, parent_id } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: 'content 必填' });
    if (parent_id) {
      const p = await db.query('SELECT id FROM comments WHERE id = $1 AND video_id = $2', [parent_id, v.id]);
      if (!p.rows[0]) return res.status(400).json({ error: 'parent comment not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO comments (video_id, user_id, parent_id, content) VALUES ($1,$2,$3,$4) RETURNING *`,
      [v.id, req.user.id, parent_id || null, content.trim().slice(0, 2000)]);
    // 通知视频作者：新评论
    if (v.owner_id !== req.user.id) {
      await emitToUser(v.owner_id, 'video.comment.created', {
        videoId: v.id, videoTitle: v.title, commentId: rows[0].id,
        by: req.user.username, content: rows[0].content, parentId: parent_id || null
      });
      await sendSystemMessage(v.owner_id,
        `「${req.user.nickname || req.user.username}」评论了你的视频《${v.title}》：${rows[0].content.slice(0, 200)}`);
    }
    res.status(201).json({ ...rows[0], username: req.user.username });
  } catch (e) { next(e); }
});

router.delete('/:commentId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM comments WHERE id = $1 AND video_id = $2',
      [req.params.commentId, req.params.videoId]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'not found' });
    if (c.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    await db.query('UPDATE comments SET deleted = true WHERE id = $1', [c.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
