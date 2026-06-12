<template>
  <div class="page">
    <h2>消息</h2>
    <div class="chat-layout">
      <!-- 会话列表 -->
      <div class="card conv-list">
        <div class="row" style="margin-bottom:10px">
          <input v-model="newPeer" placeholder="输入用户名发起私聊" @keyup.enter="startConversation" />
          <button style="white-space:nowrap" @click="startConversation">发起</button>
        </div>
        <div v-for="c in conversations" :key="c.id"
             class="conv-item" :class="{ active: current && current.id === c.id }" @click="openConversation(c)">
          <div class="row" style="justify-content:space-between">
            <strong>{{ convName(c) }}</strong>
            <span v-if="c.unread" class="tag live">{{ c.unread }}</span>
          </div>
          <div class="muted" style="font-size:12px">
            {{ c.last_message ? (c.last_message.encrypted ? '[加密消息]' : c.last_message.content.slice(0, 40)) : '暂无消息' }}
          </div>
        </div>
      </div>

      <!-- 消息面板 -->
      <div class="card msg-panel" v-if="current">
        <div class="row" style="justify-content:space-between;border-bottom:1px solid #2b3242;padding-bottom:8px">
          <strong>{{ convName(current) }}</strong>
          <span class="tag" :class="current.type === 'direct' ? 'ok' : ''">
            {{ current.type === 'direct' ? '🔒 端到端加密' : '📢 通知与反馈通道' }}
          </span>
        </div>
        <p v-if="current.type === 'system'" class="muted" style="margin:8px 0 0">
          在这里收到站点通知（审核结果/举报受理/评论提醒等）；你发送的内容将作为反馈直达管理员。
        </p>
        <p v-if="current.type === 'direct' && !current.peer.public_key" class="muted" style="margin:8px 0 0;color:var(--danger)">
          对方还未初始化聊天密钥（需对方登录后打开一次消息页），暂时无法发送加密消息。
        </p>
        <div class="chat-msgs" ref="msgBox">
          <div v-for="m in messages" :key="m.id" class="msg" :class="{ mine: m.sender_id === auth.user.id, sys: m.sender_id === null }">
            <div class="bubble">
              <span v-if="m.sender_id === null" class="muted" style="font-size:11px">系统 · {{ fmt(m.created_at) }}</span>
              <span v-else class="muted" style="font-size:11px">
                {{ m.sender_id === auth.user.id ? '我' : convName(current) }} · {{ fmt(m.created_at) }}
              </span>
              <div style="white-space:pre-wrap;word-break:break-word">{{ m.text }}</div>
            </div>
          </div>
          <p v-if="!messages.length" class="muted" style="text-align:center">暂无消息</p>
        </div>
        <div class="row">
          <input v-model="draft" :placeholder="current.type === 'system' ? '向管理员发送反馈…' : '发送加密消息…'"
                 :disabled="current.type === 'direct' && !current.peer.public_key"
                 @keyup.enter="send" />
          <button :disabled="sending || (current.type === 'direct' && !current.peer.public_key)" @click="send">发送</button>
        </div>
      </div>
      <div v-else class="card msg-panel muted" style="display:flex;align-items:center;justify-content:center">
        选择一个会话开始聊天
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { useAuth } from '../store';
import { getRealtimeWS } from '../realtime';
import { ensureKeyPair, deriveSharedKey, encryptText, decryptText } from '../chatCrypto';

const auth = useAuth();
const route = useRoute();
const conversations = ref([]);
const current = ref(null);
const messages = ref([]);
const draft = ref('');
const newPeer = ref('');
const sending = ref(false);
const msgBox = ref(null);
let myKeys = null;
const sharedKeys = new Map(); // convId -> CryptoKey
let off = null;

function convName(c) {
  if (c.type === 'system') return '系统消息';
  return c.peer ? (c.peer.nickname || c.peer.username) : '未知用户';
}
function fmt(t) { return new Date(t).toLocaleString(); }

async function scrollBottom() {
  await nextTick();
  if (msgBox.value) msgBox.value.scrollTop = msgBox.value.scrollHeight;
}

async function getConvKey(c) {
  if (c.type !== 'direct' || !c.peer || !c.peer.public_key) return null;
  if (!sharedKeys.has(c.id)) {
    sharedKeys.set(c.id, await deriveSharedKey(myKeys.priv, JSON.parse(c.peer.public_key)));
  }
  return sharedKeys.get(c.id);
}

async function renderMessage(c, m) {
  if (!m.encrypted) return { ...m, text: m.content };
  try {
    const key = await getConvKey(c);
    if (!key) return { ...m, text: '[无法解密：缺少对方公钥]' };
    return { ...m, text: await decryptText(key, m.content, m.iv) };
  } catch {
    return { ...m, text: '[无法解密：密钥已更换或数据损坏]' };
  }
}

async function loadConversations() {
  conversations.value = await api('/chat/conversations');
}

async function openConversation(c) {
  current.value = c;
  const raw = await api(`/chat/conversations/${c.id}/messages`);
  messages.value = await Promise.all(raw.map((m) => renderMessage(c, m)));
  await api(`/chat/conversations/${c.id}/read`, { method: 'POST' });
  c.unread = 0;
  scrollBottom();
}

async function startConversation() {
  const username = newPeer.value.trim();
  if (!username) return;
  try {
    const conv = await api('/chat/conversations', { method: 'POST', body: { username } });
    newPeer.value = '';
    await loadConversations();
    const c = conversations.value.find((x) => x.id === conv.id);
    if (c) await openConversation(c);
  } catch (e) { alert(e.message); }
}

async function send() {
  const text = draft.value.trim();
  if (!text || !current.value || sending.value) return;
  sending.value = true;
  try {
    let body;
    if (current.value.type === 'direct') {
      const key = await getConvKey(current.value);
      if (!key) { alert('对方还未初始化聊天密钥'); return; }
      const enc = await encryptText(key, text);
      body = { content: enc.content, encrypted: true, iv: enc.iv };
    } else {
      body = { content: text };
    }
    const m = await api(`/chat/conversations/${current.value.id}/messages`, { method: 'POST', body });
    messages.value.push({ ...m, text });
    draft.value = '';
    scrollBottom();
  } catch (e) { alert(e.message); }
  finally { sending.value = false; }
}

async function onWsMessage(msg) {
  if (msg.type !== 'chat.message.new' || msg.scope !== 'personal') return;
  const m = msg.message || {};
  if (auth.user && m.sender_id === auth.user.id) return;
  if (current.value && msg.conversationId === current.value.id) {
    messages.value.push(await renderMessage(current.value, m));
    api(`/chat/conversations/${current.value.id}/read`, { method: 'POST' }).catch(() => {});
    scrollBottom();
  } else {
    const c = conversations.value.find((x) => x.id === msg.conversationId);
    if (c) { c.unread = (c.unread || 0) + 1; c.last_message = m; }
    else loadConversations();
  }
}

onMounted(async () => {
  // 初始化端到端加密密钥并上报公钥（幂等）
  myKeys = await ensureKeyPair(auth.user.id);
  await api('/chat/keys', { method: 'PUT', body: { public_key: JSON.stringify(myKeys.pub) } });
  await loadConversations();
  const target = route.query.c
    ? conversations.value.find((c) => c.id === route.query.c)
    : conversations.value[0];
  if (target) await openConversation(target);
  off = getRealtimeWS().on(onWsMessage);
});
onBeforeUnmount(() => { if (off) off(); });
</script>

<style scoped>
.chat-layout { display: flex; gap: 14px; }
.conv-list { width: 280px; flex-shrink: 0; max-height: 70vh; overflow-y: auto; }
.conv-item { padding: 10px; border-radius: 8px; cursor: pointer; }
.conv-item:hover { background: var(--panel2); }
.conv-item.active { background: var(--panel2); outline: 1px solid var(--accent); }
.msg-panel { flex: 1; display: flex; flex-direction: column; height: 70vh; }
.msg-panel .chat-msgs { flex: 1; margin: 8px 0; }
.msg { display: flex; margin-bottom: 8px; }
.msg.mine { justify-content: flex-end; }
.msg .bubble { background: var(--panel2); border-radius: 10px; padding: 8px 12px; max-width: 75%; }
.msg.mine .bubble { background: rgba(79,140,255,.2); }
.msg.sys .bubble { background: rgba(62,207,142,.08); }
@media (max-width: 720px) {
  .chat-layout { flex-direction: column; }
  .conv-list { width: 100%; max-height: 200px; }
  .msg-panel { height: 60vh; }
}
</style>
