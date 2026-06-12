'use strict';
// 聊天子系统公共逻辑：系统消息会话（通知推送 + 用户反馈通道）
// direct 会话为端到端加密（服务器只存密文）；system 会话为明文（服务端生成通知、管理员需读取反馈）
const db = require('../db/pool');
const { emitToUser } = require('./events');

// 确保用户拥有「系统消息」会话（懒创建，老用户首次拉会话列表时补建）
async function ensureSystemConversation(userId) {
  const { rows } = await db.query(
    `SELECT c.id FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id
     WHERE c.type = 'system' AND m.user_id = $1 LIMIT 1`, [userId]);
  if (rows[0]) return rows[0].id;
  const conv = await db.query(`INSERT INTO conversations (type) VALUES ('system') RETURNING id`);
  await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`, [conv.rows[0].id, userId]);
  return conv.rows[0].id;
}

// 向用户的系统消息会话推送一条通知（视频审核/举报受理/下架/封禁/新评论等），并经个人事件通道触达
async function sendSystemMessage(userId, content, meta = {}) {
  const convId = await ensureSystemConversation(userId);
  const { rows } = await db.query(
    `INSERT INTO chat_messages (conversation_id, sender_id, content, encrypted)
     VALUES ($1, NULL, $2, false) RETURNING id, conversation_id, sender_id, content, encrypted, iv, created_at`,
    [convId, String(content).slice(0, 2000)]);
  await emitToUser(userId, 'chat.message.new', {
    conversationId: convId, conversationType: 'system', message: rows[0], ...meta
  });
  return rows[0];
}

module.exports = { ensureSystemConversation, sendSystemMessage };
