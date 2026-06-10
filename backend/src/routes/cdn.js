'use strict';
// 公网 CDN 节点：管理员手动配置（如腾讯云 CDN / Cloudflare），点播对象存储播放调度（轮询健康节点）
// 注：私有（局域网自建）CDN 边缘节点已移除，仅支持公网 CDN；直播已迁移至 TRTC，不再经 CDN。
const express = require('express');
const db = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
let rrCounter = 0;

// 选一个可用公网 CDN 节点（round-robin），无则回源（返回 null）
async function pickEdge() {
  const { rows } = await db.query(`SELECT id, name, base_url FROM cdn_nodes WHERE enabled = true ORDER BY id`);
  if (rows.length === 0) return null;
  return rows[rrCounter++ % rows.length];
}

// ---- 管理员管理 ----
router.use(requireAuth, requireAdmin);

router.get('/nodes', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cdn_nodes ORDER BY id');
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/nodes', async (req, res, next) => {
  try {
    const { name, base_url, enabled = true } = req.body || {};
    if (!name || !base_url) return res.status(400).json({ error: 'name/base_url 必填' });
    if (!/^https?:\/\//.test(base_url)) return res.status(400).json({ error: 'base_url 必须是 http(s) 地址' });
    const { rows } = await db.query(
      `INSERT INTO cdn_nodes (name, base_url, enabled, type) VALUES ($1,$2,$3,'public')
       ON CONFLICT (name) DO UPDATE SET base_url = $2, enabled = $3, type = 'public' RETURNING *`,
      [name, base_url.replace(/\/$/, ''), enabled]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.patch('/nodes/:id', async (req, res, next) => {
  try {
    const { base_url, enabled, name } = req.body || {};
    if (base_url !== undefined && !/^https?:\/\//.test(base_url)) {
      return res.status(400).json({ error: 'base_url 必须是 http(s) 地址' });
    }
    const { rows } = await db.query(
      `UPDATE cdn_nodes SET name = COALESCE($1, name), base_url = COALESCE($2, base_url),
        enabled = COALESCE($3, enabled) WHERE id = $4 RETURNING *`,
      [name, base_url && base_url.replace(/\/$/, ''), enabled, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.delete('/nodes/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM cdn_nodes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 健康检查（管理员触发）：公网 CDN 探测可达性（HEAD 根路径，5xx 视为不健康）
router.post('/nodes/check', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cdn_nodes');
    const results = [];
    for (const n of rows) {
      let ok = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(n.base_url, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(t);
        ok = r.status < 500;
      } catch { ok = false; }
      if (ok) await db.query('UPDATE cdn_nodes SET last_seen_at = now() WHERE id = $1', [n.id]);
      results.push({ id: n.id, name: n.name, base_url: n.base_url, healthy: ok });
    }
    res.json(results);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.pickEdge = pickEdge;
