'use strict';
// 端到端加密聊天：会话/消息/公钥
// - direct 会话：客户端 ECDH(P-256) 协商共享密钥 + AES-256-GCM 加密，服务器只保存密文与 IV
// - system 会话：系统通知 + 反馈通道（用户发送的消息作为反馈推送给管理员），明文存储
const express = require('express');
const db = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { emitToUser, emitToAdmins } = require('../lib/events');
const { ensureSystemConversation } = require('../lib/chat');

const router = express.Router();
router.use(requireAuth);

// ---- 公钥管理（端到端加密握手）----
// 上传/更新自己的聊天公钥（ECDH P-256 JWK JSON 字符串）
router.put('/keys', async (req, res, next) => {
  try {
    const pub = req.body && req.body.public_key;
    if (!pub || String(pub).length > 2000) return res.status(400).json({ error: 'public_key 必填（ECDH P-256 JWK）' });
    await db.query('UPDATE users SET chat_public_key = $1 WHERE id = $2', [String(pub), req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/keys/:userId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, username, nickname, chat_public_key FROM users WHERE id = $1', [req.params.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'user not found' });
    res.json({ user_id: rows[0].id, username: rows[0].username, nickname: rows[0].nickname, public_key: rows[0].chat_public_key });
  } catch (e) { next(e); }
});

// ---- 会话 ----
async function getMembership(convId, userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.type, m.last_read_at FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2
     WHERE c.id = $1`, [convId, userId]);
  return rows[0] || null;
}

// 会话列表（系统消息会话置顶；附对方信息/公钥、最后一条消息、未读数）
router.get('/conversations', async (req, res, next) => {
  try {
    await ensureSystemConversation(req.user.id);
    const { rows } = await db.query(
      `SELECT c.id, c.type, m.last_read_at,
         peer.id AS peer_id, peer.username AS peer_username, peer.nickname AS peer_nickname,
         peer.chat_public_key AS peer_public_key,
         lm.id AS last_id, lm.sender_id AS last_sender_id, lm.content AS last_content,
         lm.encrypted AS last_encrypted, lm.iv AS last_iv, lm.created_at AS last_at,
         (SELECT count(*)::int FROM chat_messages x
           WHERE x.conversation_id = c.id AND x.created_at > m.last_read_at
             AND (x.sender_id IS NULL OR x.sender_id <> $1)) AS unread
       FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1
       LEFT JOIN conversation_members pm ON pm.conversation_id = c.id AND pm.user_id <> $1
       LEFT JOIN users peer ON peer.id = pm.user_id
       LEFT JOIN LATERAL (
         SELECT * FROM chat_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
       ) lm ON true
       ORDER BY (c.type = 'system') DESC, lm.created_at DESC NULLS LAST`, [req.user.id]);
    res.json(rows.map((r) => ({
      id: r.id,
      type: r.type,
      peer: r.peer_id ? {
        id: r.peer_id, username: r.peer_username, nickname: r.peer_nickname, public_key: r.peer_public_key
      } : null,
      last_message: r.last_id ? {
        id: r.last_id, sender_id: r.last_sender_id, content: r.last_content,
        encrypted: r.last_encrypted, iv: r.last_iv, created_at: r.last_at
      } : null,
      unread: r.unread || 0,
      last_read_at: r.last_read_at
    })));
  } catch (e) { next(e); }
});

// 发起/获取与某用户的私聊会话 body: { username } 或 { user_id }
router.post('/conversations', async (req, res, next) => {
  try {
    const { username, user_id } = req.body || {};
    const q = user_id
      ? await db.query('SELECT id, username, nickname, chat_public_key FROM users WHERE id = $1', [user_id])
      : await db.query('SELECT id, username, nickname, chat_public_key FROM users WHERE username = $1', [String(username || '').trim()]);
    const peer = q.rows[0];
    if (!peer) return res.status(404).json({ error: '用户不存在' });
    if (peer.id === req.user.id) return res.status(400).json({ error: '不能和自己私聊' });

    const exist = await db.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
       WHERE c.type = 'direct' LIMIT 1`, [req.user.id, peer.id]);
    let convId = exist.rows[0] && exist.rows[0].id;
    if (!convId) {
      const conv = await db.query(`INSERT INTO conversations (type) VALUES ('direct') RETURNING id`);
      convId = conv.rows[0].id;
      await db.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [convId, req.user.id, peer.id]);
    }
    res.status(201).json({
      id: convId, type: 'direct',
      peer: { id: peer.id, username: peer.username, nickname: peer.nickname, public_key: peer.chat_public_key }
    });
  } catch (e) { next(e); }
});

// 消息历史（升序；?before_id= 翻旧页）
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conv = await getMembership(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const beforeId = parseInt(req.query.before_id || '0', 10);
    const params = [conv.id, limit];
    let where = 'conversation_id = $1';
    if (beforeId > 0) { params.push(beforeId); where += ' AND id < $3'; }
    const { rows } = await db.query(
      `SELECT id, conversation_id, sender_id, content, encrypted, iv, created_at
       FROM chat_messages WHERE ${where} ORDER BY id DESC LIMIT $2`, params);
    res.json(rows.reverse());
  } catch (e) { next(e); }
});

// 发送消息 body: { content, encrypted?, iv? }
// direct 会话要求 encrypted=true（端到端加密，content 为密文）；system 会话作为用户反馈（明文）
router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conv = await getMembership(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    const { content, encrypted, iv } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content 必填' });
    if (String(content).length > 20000) return res.status(400).json({ error: '消息过长' });

    if (conv.type === 'direct') {
      if (!encrypted || !iv) return res.status(400).json({ error: '私聊必须端到端加密（encrypted=true 且带 iv）' });
    }
    const isEncrypted = conv.type === 'direct';
    const { rows } = await db.query(
      `INSERT INTO chat_messages (conversation_id, sender_id, content, encrypted, iv)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, conversation_id, sender_id, content, encrypted, iv, created_at`,
      [conv.id, req.user.id, String(content), isEncrypted, isEncrypted ? String(iv) : null]);
    const message = rows[0];
    await db.query(
      `UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`,
      [conv.id, req.user.id]);

    if (conv.type === 'system') {
      // 反馈通道：推送给所有管理员（WS admin scope + 管理员 webhook），可在后台/API 查询
      await emitToAdmins('admin.feedback.created', {
        conversationId: conv.id, messageId: message.id,
        userId: req.user.id, username: req.user.username, nickname: req.user.nickname || '',
        content: message.content
      });
    } else {
      const peers = await db.query(
        `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
        [conv.id, req.user.id]);
      for (const p of peers.rows) {
        await emitToUser(p.user_id, 'chat.message.new', {
          conversationId: conv.id, conversationType: 'direct',
          from: { id: req.user.id, username: req.user.username, nickname: req.user.nickname || '' },
          message
        });
      }
    }
    res.status(201).json(message);
  } catch (e) { next(e); }
});

// 标记已读
router.post('/conversations/:id/read', async (req, res, next) => {
  try {
    const conv = await getMembership(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    await db.query(
      `UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`,
      [conv.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
