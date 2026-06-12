'use strict';
// 创作者信息与主页视频列表
const express = require('express');
const db = require('../db/pool');
const { optionalAuth } = require('../middleware/auth');
const { objectUrl } = require('../lib/minio');
const config = require('../config');

const router = express.Router();

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, username, nickname, bio, created_at FROM users WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'user not found' });
    const stats = await db.query(
      `SELECT count(*)::int AS video_count, COALESCE(sum(views),0)::bigint AS total_views
       FROM videos WHERE owner_id = $1 AND visibility='public' AND status='approved'`, [req.params.id]);
    res.json({ ...rows[0], ...stats.rows[0] });
  } catch (e) { next(e); }
});

// 创作者主页视频列表（公开+已审核；本人/管理员可看全部）
router.get('/:id/videos', optionalAuth, async (req, res, next) => {
  try {
    const isSelf = req.user && (String(req.user.id) === req.params.id || req.user.role === 'admin');
    const where = isSelf
      ? 'owner_id = $1'
      : `owner_id = $1 AND visibility = 'public' AND status = 'approved'`;
    const { rows } = await db.query(
      `SELECT id, title, description, thumbnail_key, duration_sec, visibility, status, views, created_at
       FROM videos WHERE ${where} ORDER BY created_at DESC LIMIT 100`, [req.params.id]);
    res.json(rows.map((v) => ({
      ...v,
      thumbnail_url: v.thumbnail_key ? objectUrl(config.buckets.thumbnails, v.thumbnail_key) : null
    })));
  } catch (e) { next(e); }
});

module.exports = router;
