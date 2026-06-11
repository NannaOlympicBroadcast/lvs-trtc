'use strict';
// 统一事件系统：入库存档 + WebSocket 推送 + 用户/直播间 Webhook 推送
// 事件类型一览（payload 均含 type / time）：
//  创作者: video.uploaded, video.review.approved, video.review.rejected,
//          video.taken_down, video.comment.created, account.banned
//  直播间: live.started, live.stopped, room.user.joined, room.user.left,
//          chat.message, mic.requested, mic.approved, mic.rejected, mic.ended,
//          recording.started, recording.stored
//  管理员: admin.video.uploaded, admin.live.started, admin.live.stopped,
//          admin.chat.message, admin.stream.urls, admin.report.created,
//          admin.feedback.created, admin.user.banned
//  聊天:   chat.message.new（系统消息/私聊新消息）; 举报: report.resolved
const crypto = require('crypto');
const db = require('../db/pool');
const { redis } = require('./redis');

const WS_CHANNEL = 'lvs:events'; // redis pub/sub -> ws gateway 扇出

function sign(secret, body) {
  return crypto.createHmac('sha256', secret || '').update(body).digest('hex');
}

async function deliverWebhook(url, secret, event) {
  const body = JSON.stringify(event);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LVS-Event': event.type,
        'X-LVS-Signature': sign(secret, body)
      },
      body,
      signal: ctrl.signal
    });
    clearTimeout(t);
  } catch (e) {
    console.warn(`[webhook] deliver failed ${url}: ${e.message}`);
  }
}

// 推送给某个用户（其 WS 连接 + 其 user_webhooks）
async function emitToUser(userId, type, payload = {}) {
  const event = { type, time: new Date().toISOString(), ...payload };
  await db.query('INSERT INTO events (type, user_id, payload) VALUES ($1, $2, $3)', [type, userId, event]);
  await redis.publish(WS_CHANNEL, JSON.stringify({ target: 'user', userId, event }));
  const { rows } = await db.query(
    'SELECT url, secret, events FROM user_webhooks WHERE user_id = $1 AND enabled = true', [userId]);
  for (const wh of rows) {
    if (wh.events.length === 0 || wh.events.includes(type)) deliverWebhook(wh.url, wh.secret, event);
  }
}

// 推送给所有管理员
async function emitToAdmins(type, payload = {}) {
  const event = { type, time: new Date().toISOString(), ...payload };
  await db.query('INSERT INTO events (type, user_id, payload) VALUES ($1, NULL, $2)', [type, event]);
  await redis.publish(WS_CHANNEL, JSON.stringify({ target: 'admins', event }));
  const { rows } = await db.query(
    `SELECT w.url, w.secret, w.events FROM user_webhooks w
     JOIN users u ON u.id = w.user_id WHERE u.role = 'admin' AND w.enabled = true`);
  for (const wh of rows) {
    if (wh.events.length === 0 || wh.events.includes(type)) deliverWebhook(wh.url, wh.secret, event);
  }
}

// 直播间事件：推给主播（用户事件通道）+ 直播间自定义回调 + 房间内 WS 广播
async function emitRoomEvent(room, type, payload = {}) {
  const event = { type, time: new Date().toISOString(), roomId: room.id, ...payload };
  await db.query('INSERT INTO events (type, user_id, payload) VALUES ($1, $2, $3)', [type, room.owner_id, event]);
  await redis.publish(WS_CHANNEL, JSON.stringify({ target: 'room', roomId: room.id, event }));
  await redis.publish(WS_CHANNEL, JSON.stringify({ target: 'user', userId: room.owner_id, event }));
  // 主播个人 webhook
  const u = await db.query('SELECT url, secret, events FROM user_webhooks WHERE user_id = $1 AND enabled = true', [room.owner_id]);
  for (const wh of u.rows) {
    if (wh.events.length === 0 || wh.events.includes(type)) deliverWebhook(wh.url, wh.secret, event);
  }
  // 直播间自定义回调
  const r = await db.query('SELECT url, secret, events FROM room_webhooks WHERE room_id = $1 AND enabled = true', [room.id]);
  for (const wh of r.rows) {
    if (wh.events.length === 0 || wh.events.includes(type)) deliverWebhook(wh.url, wh.secret, event);
  }
}

module.exports = { emitToUser, emitToAdmins, emitRoomEvent, WS_CHANNEL };
