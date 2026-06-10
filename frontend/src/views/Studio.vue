<template>
  <div class="page" v-if="room">
    <!-- Header -->
    <div class="row style-header" style="margin-bottom:14px">
      <span class="tag" :class="{ live: room.is_live }">{{ room.is_live ? '直播中' : '未开播' }}</span>
      <h2 style="margin:0">主播控制台 — {{ room.title }}</h2>
      <span class="spacer"></span>
      <router-link :to="`/live/${room.id}`"><button class="ghost">观众视角</button></router-link>
    </div>

    <p v-if="room.trtc_error" class="notice-text" style="color:var(--danger)">{{ room.trtc_error }}</p>

    <!-- 3-Column Layout -->
    <div class="studio-layout">
      <!-- Left Column: Web Push & Mic Management -->
      <div class="studio-left">
        <!-- Option 1: Web Push via TRTC -->
        <div class="card form-grid">
          <h3>方式一：网页开播（TRTC 摄像头/屏幕）</h3>
          <div ref="preview" class="trtc-preview"></div>
          <div class="row">
            <button v-if="!publishing" @click="startWebPush('camera')" :disabled="!!room.trtc_error">📷 摄像头开播</button>
            <button v-if="!publishing" class="ghost" @click="startWebPush('screen')" :disabled="!!room.trtc_error">🖥️ 屏幕共享开播</button>
            <button v-else class="danger" @click="stopWebPush">下播</button>
          </div>
        </div>

        <!-- Co-hosting Management -->
        <div class="card">
          <h3>连麦管理</h3>
          <table>
            <tr><th>用户</th><th>状态/画面</th><th>动作</th></tr>
            <tr v-for="m in mics" :key="m.id">
              <td>{{ m.username }}<br /><span class="muted">{{ m.created_at ? new Date(m.created_at).toLocaleString() : '' }}</span></td>
              <td>
                <div v-if="m.status === 'live'" :ref="(el) => setGuestEl(m.rtc_user_id, el)" class="trtc-guest"></div>
                <span v-else class="tag warn">{{ m.status === 'requested' ? '等待处理' : m.status }}</span>
              </td>
              <td class="row">
                <template v-if="m.status === 'requested'">
                  <button @click="decide(m, true)">接受</button>
                  <button class="ghost danger-text" @click="decide(m, false)">否决</button>
                </template>
                <button v-if="['approved','live'].includes(m.status)" class="danger" @click="endMic(m)">结束连麦</button>
              </td>
            </tr>
          </table>
          <p v-if="!mics.length" class="muted">暂无连麦请求</p>
        </div>
      </div>

      <!-- Middle Column: Live management / Settings / Callbacks Tabs -->
      <div class="studio-mid">
        <div class="tabs">
          <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="tab = t.key">{{ t.name }}</button>
        </div>

        <!-- Live Management Tab -->
        <div v-show="tab === 'stream'" class="card form-grid">
          <h3>方式二：OBS 等软件 RTMP 推流进 TRTC 房间</h3>
          <p class="muted">需开通腾讯云 RTC-Engine 基础版/专业版套餐。OBS 推流后请点击下方「标记开播」让观众进入；
            停止推流后点「标记下播」。</p>

          <div class="input-copy-group" v-if="rtmpPush">
            <span class="label">服务器：</span>
            <div class="input-copy-row">
              <input readonly :value="rtmpPush.server" class="copy-input" />
              <button class="copy-btn" @click="copyText(rtmpPush.server)" title="复制">
                <svg class="copy-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" /></svg>
              </button>
            </div>
          </div>

          <div class="input-copy-group" v-if="rtmpPush">
            <span class="label">推流码：</span>
            <div class="input-copy-row">
              <input readonly :value="rtmpPush.stream_key" class="copy-input" />
              <button class="copy-btn" @click="copyText(rtmpPush.stream_key)" title="复制">
                <svg class="copy-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" /></svg>
              </button>
            </div>
          </div>

          <div class="row" style="margin-top:10px">
            <button class="ghost" v-if="!room.is_live" @click="markLive(true)">📡 标记开播</button>
            <button class="ghost" v-else @click="markLive(false)">⏹ 标记下播</button>
          </div>

          <h3 style="margin-top:14px">TRTC 房间信息</h3>
          <div class="url-list">
            <div class="url-item">
              <span class="url-label">房间号:</span>
              <code class="url-code">{{ room.stream_key }}</code>
            </div>
            <div class="url-item" v-if="room.publish && room.publish.trtc">
              <span class="url-label">SDKAppID:</span>
              <code class="url-code">{{ room.publish.trtc.sdk_app_id }}</code>
            </div>
          </div>
          <p class="muted">录制说明：服务端录制已随 SRS 移除；如需录制请在腾讯云控制台开通 TRTC 云端录制。</p>
        </div>

        <!-- Settings Tab -->
        <div v-show="tab === 'settings'" class="card form-grid">
          <h3>直播间设置</h3>
          <input v-model="form.title" placeholder="标题" />
          <textarea v-model="form.description" rows="2" placeholder="简介"></textarea>
          <input v-model="form.password" placeholder="直播间密码（留空 = 无密码）" />
          <button @click="saveSettings">保存</button>

          <h3>黑名单</h3>
          <div class="row">
            <input v-model="blackName" placeholder="要拉黑的用户名" style="max-width:220px" />
            <button class="ghost" @click="addBlack">拉黑</button>
          </div>
          <table v-if="blacklist.length">
            <tr v-for="b in blacklist" :key="b.user_id">
              <td>{{ b.username }}</td>
              <td><button class="ghost" @click="removeBlack(b)">移除</button></td>
            </tr>
          </table>
        </div>

        <!-- Events Webhook Tab -->
        <div v-show="tab === 'webhooks'" class="card form-grid">
          <h3>直播间事件回调（Webhook）</h3>
          <p class="muted">可监听: live.started, live.stopped, live.cut, room.user.joined, room.user.left, chat.message,
            mic.requested, mic.approved, mic.rejected, mic.live, mic.ended。
            留空 = 全部事件。也可直接连接 <code>/ws?token=...</code> 以 WebSocket 实时接收。</p>
          <input v-model="whForm.url" placeholder="回调 URL（http://...）" />
          <input v-model="whForm.secret" placeholder="签名密钥（可选，HMAC-SHA256 于 X-LVS-Signature 头）" />
          <input v-model="whForm.events" placeholder="事件列表，逗号分隔（留空=全部）" />
          <button @click="addWebhook">添加回调</button>
          <table v-if="webhooks.length">
            <tr><th>URL</th><th>事件</th><th></th></tr>
            <tr v-for="w in webhooks" :key="w.id">
              <td><code>{{ w.url }}</code></td>
              <td>{{ w.events.length ? w.events.join(', ') : '全部' }}</td>
              <td><button class="ghost" @click="delWebhook(w)">删除</button></td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Right Column: Interactive Chat Room -->
      <div class="studio-right">
        <div class="chat-panel">
          <div class="chat-header">
            <h4>互动聊天</h4>
          </div>
          <div class="chat-msgs" ref="msgBox">
            <div v-for="(m, i) in messages" :key="i" :class="{ sys: m.sys }">
              <template v-if="m.sys">{{ m.text }}</template>
              <template v-else><strong>{{ m.username }}：</strong>{{ m.content }}</template>
            </div>
          </div>
          <div class="row chat-input-area">
            <input v-model="chatInput" :placeholder="auth.loggedIn ? '发送消息...' : '登录后可发言'"
              :disabled="!auth.loggedIn" @keyup.enter="sendChat" />
            <button :disabled="!auth.loggedIn" @click="sendChat">发送</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Notice banner -->
    <p v-if="notice" class="notice-text">{{ notice }}</p>

    <!-- Bottom-right mic request popup modal -->
    <Transition name="slide-up">
      <div v-if="activeMicRequest" class="mic-request-popup">
        <div class="popup-header">
          <span class="popup-title">🎤 连麦申请</span>
          <button class="close-btn" @click="activeMicRequest = null">&times;</button>
        </div>
        <div class="popup-body">
          <strong>{{ activeMicRequest.username }}</strong> 申请与您连麦。
        </div>
        <div class="popup-actions">
          <button class="accept-btn" @click="handlePopupDecision(true)">接听</button>
          <button class="reject-btn" @click="handlePopupDecision(false)">拒绝</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { createWS } from '../ws';
import { createTrtc, enterRoom, exitRoom, TRTC, trtcErrorText } from '../trtc';
import { ensureCapture, captureErrorText } from '../media';
import { useAuth } from '../store';

const route = useRoute();
const auth = useAuth();
const roomId = route.params.id;

const tabs = [
  { key: 'stream', name: '直播管理' },
  { key: 'settings', name: '设置与黑名单' },
  { key: 'webhooks', name: '事件回调' }
];
const tab = ref('stream');
const room = ref(null), rtmpPush = ref(null), mics = ref([]), blacklist = ref([]), webhooks = ref([]);
const form = ref({ title: '', description: '', password: '' });
const whForm = ref({ url: '', secret: '', events: '' });
const blackName = ref(''), notice = ref('');
const publishing = ref(false);
const preview = ref(null);

// Chat-related state
const messages = ref([]);
const chatInput = ref('');
const msgBox = ref(null);

// Popup request state
const activeMicRequest = ref(null);

let trtc = null, inRoom = false, ws = null, screenSharing = false;
const guestEls = new Map();     // rtc_user_id -> 容器元素
const remoteVideos = new Map(); // `${userId}|${streamType}`

async function load() {
  room.value = await api(`/live/rooms/${roomId}`);
  form.value = { title: room.value.title, description: room.value.description, password: room.value.password || '' };
  rtmpPush.value = room.value.publish ? room.value.publish.rtmp : null;
  mics.value = await api(`/live/rooms/${roomId}/mic`);
  blacklist.value = await api(`/live/rooms/${roomId}/blacklist`);
  webhooks.value = await api(`/live/rooms/${roomId}/webhooks`);

  // Load chat messages history
  const history = await api(`/live/rooms/${roomId}/messages`);
  messages.value = history.map((m) => ({ username: m.username, content: m.content }));
  scrollChat();
}

function scrollChat() {
  nextTick(() => { if (msgBox.value) msgBox.value.scrollTop = msgBox.value.scrollHeight; });
}

// ---- TRTC：主播进房 / 渲染连麦者画面 ----
async function ensureTrtcRoom() {
  if (inRoom) return;
  trtc = createTrtc();
  trtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, ({ userId, streamType }) => {
    remoteVideos.set(`${userId}|${streamType}`, true);
    renderGuest(userId, streamType);
  });
  trtc.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, ({ userId, streamType }) => {
    remoteVideos.delete(`${userId}|${streamType}`);
    trtc.stopRemoteVideo({ userId, streamType }).catch(() => {});
  });
  await enterRoom(trtc, room.value.publish.trtc, 'anchor');
  inRoom = true;
}

async function leaveTrtcRoom() {
  if (trtc) { await exitRoom(trtc); trtc = null; }
  inRoom = false;
  remoteVideos.clear();
}

async function renderGuest(userId, streamType) {
  if (!trtc) return;
  const el = guestEls.get(userId);
  if (!el) return;
  try { await trtc.startRemoteVideo({ userId, streamType, view: el }); }
  catch (e) { notice.value = `连麦画面拉取失败: ${trtcErrorText(e)}`; }
}

function setGuestEl(rtcUserId, el) {
  if (!el || guestEls.get(rtcUserId) === el) return;
  guestEls.set(rtcUserId, el);
  for (const key of remoteVideos.keys()) {
    const [uid, st] = key.split('|');
    if (uid === rtcUserId) renderGuest(uid, st);
  }
}

function setupWS() {
  ws = createWS();
  ws.send({ type: 'join', roomId, password: form.value.password });
  ws.on((msg) => {
    // Reload data for mic and room control signals
    if (['mic.requested', 'mic.live', 'mic.ended', 'live.started', 'live.stopped'].includes(msg.type)) {
      load();
      if (msg.type === 'mic.requested') {
        notice.value = `🎤 ${msg.username} 请求连麦`;
        activeMicRequest.value = { id: msg.micId, username: msg.username };
      }
    }
    // 管理员断流：立即退出 TRTC 房间停止推流
    if (msg.type === 'live.cut') {
      notice.value = `直播已被管理员断流${msg.reason ? `（${msg.reason}）` : ''}`;
      stopWebPush(true);
      load();
    }

    // Handle chat panel events
    if (msg.scope === 'room') {
      if (msg.type === 'chat.message') {
        messages.value.push({ username: msg.username, content: msg.content });
        scrollChat();
      } else if (msg.type === 'room.user.joined') {
        messages.value.push({ sys: true, text: `${msg.username} 进入直播间` });
        scrollChat();
      } else if (msg.type === 'room.user.left') {
        messages.value.push({ sys: true, text: `${msg.username} 离开直播间` });
        scrollChat();
      }
    }
  });
}

function sendChat() {
  const content = chatInput.value.trim();
  if (!content) return;
  ws.send({ type: 'chat', roomId, content });
  chatInput.value = '';
}

// ---- 网页开播（TRTC anchor 进房 + 本地采集发布） ----
async function startWebPush(kind) {
  if (!ensureCapture()) return; // 摄像头/屏幕共享需要 HTTPS 安全上下文
  if (!room.value.publish || !room.value.publish.trtc) {
    notice.value = room.value.trtc_error || 'TRTC 未配置，无法开播';
    return;
  }
  try {
    await ensureTrtcRoom();
    await trtc.startLocalAudio().catch((e) => { notice.value = `⚠️ 麦克风不可用（${captureErrorText(e)}）`; });
    if (kind === 'screen') {
      await trtc.startScreenShare({ view: preview.value });
      screenSharing = true;
    } else {
      await trtc.startLocalVideo({ view: preview.value });
    }
    await api(`/live/rooms/${roomId}/live/start`, { method: 'POST' });
    publishing.value = true;
    notice.value = '网页开播成功（TRTC）';
    load();
  } catch (e) {
    notice.value = `开播失败: ${trtcErrorText(e)}`;
    await leaveTrtcRoom();
  }
}

async function stopWebPush(cutByAdmin = false) {
  if (trtc) {
    if (screenSharing) { try { await trtc.stopScreenShare(); } catch { /* 忽略 */ } }
    try { await trtc.stopLocalVideo(); } catch { /* 忽略 */ }
    try { await trtc.stopLocalAudio(); } catch { /* 忽略 */ }
  }
  screenSharing = false;
  await leaveTrtcRoom();
  publishing.value = false;
  if (!cutByAdmin && room.value && room.value.is_live) {
    await api(`/live/rooms/${roomId}/live/stop`, { method: 'POST' }).catch(() => {});
  }
  load();
}

// OBS 推流场景：手动标记开播/下播
async function markLive(start) {
  try {
    await api(`/live/rooms/${roomId}/live/${start ? 'start' : 'stop'}`, { method: 'POST' });
    notice.value = start ? '已标记开播' : '已标记下播';
    // 主播网页端同时进房，便于查看连麦者画面
    if (start && room.value.publish && room.value.publish.trtc) await ensureTrtcRoom().catch(() => {});
    if (!start) await leaveTrtcRoom();
    load();
  } catch (e) { notice.value = e.message; }
}

async function decide(m, approve) {
  await api(`/live/rooms/${roomId}/mic/${m.id}/decision`, { method: 'POST', body: { approve } });
  // 同意连麦后确保主播已在 TRTC 房间内（能看到/听到连麦者）
  if (approve && room.value.publish && room.value.publish.trtc) await ensureTrtcRoom().catch(() => {});
  load();
}

async function handlePopupDecision(approve) {
  if (!activeMicRequest.value) return;
  const m = { id: activeMicRequest.value.id, username: activeMicRequest.value.username };
  activeMicRequest.value = null;
  await decide(m, approve);
}

async function endMic(m) {
  await api(`/live/rooms/${roomId}/mic/${m.id}/end`, { method: 'POST' });
  load();
}

async function saveSettings() {
  await api(`/live/rooms/${roomId}`, { method: 'PATCH', body: { ...form.value } });
  notice.value = '设置已保存';
  load();
}

async function addBlack() {
  if (!blackName.value) return;
  try {
    await api(`/live/rooms/${roomId}/blacklist`, { method: 'POST', body: { username: blackName.value } });
    blackName.value = '';
    load();
  } catch (e) { notice.value = e.message; }
}
async function removeBlack(b) {
  await api(`/live/rooms/${roomId}/blacklist/${b.user_id}`, { method: 'DELETE' });
  load();
}

async function addWebhook() {
  try {
    await api(`/live/rooms/${roomId}/webhooks`, {
      method: 'POST',
      body: {
        url: whForm.value.url,
        secret: whForm.value.secret,
        events: whForm.value.events ? whForm.value.events.split(',').map((s) => s.trim()).filter(Boolean) : []
      }
    });
    whForm.value = { url: '', secret: '', events: '' };
    load();
  } catch (e) { notice.value = e.message; }
}
async function delWebhook(w) {
  await api(`/live/rooms/${roomId}/webhooks/${w.id}`, { method: 'DELETE' });
  load();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = '已复制到剪贴板';
    setTimeout(() => {
      if (notice.value === '已复制到剪贴板') notice.value = '';
    }, 2000);
  } catch (e) {
    notice.value = '复制失败: ' + e.message;
  }
}

onMounted(async () => { await load(); setupWS(); });
onBeforeUnmount(async () => { await stopWebPush(true); if (ws) ws.close(); });
</script>

<style scoped>
/* 3-column layout structure */
.studio-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin-top: 14px;
}

.studio-left {
  flex: 1.2;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.studio-mid {
  flex: 1.5;
  min-width: 0;
}

.studio-right {
  width: 320px;
  flex-shrink: 0;
}

/* TRTC 渲染容器 */
.trtc-preview {
  width: 100%;
  max-height: 300px;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}
.trtc-guest {
  width: 160px;
  aspect-ratio: 4 / 3;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
}

/* Copy group style */
.input-copy-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.input-copy-group .label {
  font-size: 14px;
  color: var(--muted);
}
.input-copy-row {
  display: flex;
  gap: 8px;
}
.copy-input {
  flex: 1;
  background: var(--panel2);
  border: 1px solid #2b3242;
  color: var(--text);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 14px;
}
.copy-btn {
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  transition: background-color 0.2s, transform 0.1s;
}
.copy-btn:hover {
  background-color: #3b74e6;
}
.copy-btn:active {
  transform: scale(0.95);
}
.copy-icon {
  width: 18px;
  height: 18px;
}

/* Playback url styling */
.url-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--panel2);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #2b3242;
  margin-bottom: 14px;
}
.url-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.url-label {
  font-weight: bold;
  color: var(--accent);
  width: 80px;
  flex-shrink: 0;
}
.url-code {
  word-break: break-all;
  background: none;
  padding: 0;
  color: var(--text);
}

/* Notice banners */
.notice-text {
  background: rgba(79, 140, 255, 0.15);
  color: var(--accent);
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 14px;
  margin-top: 14px;
  border: 1px solid rgba(79, 140, 255, 0.3);
}

/* Chat Panel */
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 580px;
  background: var(--panel);
  border-radius: var(--radius);
  border: 1px solid #2b3242;
  overflow: hidden;
}
.chat-header {
  padding: 12px 16px;
  background: var(--panel2);
  border-bottom: 1px solid #2b3242;
}
.chat-header h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.chat-input-area {
  padding: 12px;
  background: var(--panel2);
  border-top: 1px solid #2b3242;
}

/* Mic request popup */
.mic-request-popup {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 280px;
  background: var(--panel2);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 16px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  z-index: 1001;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.popup-title {
  font-weight: bold;
  color: var(--accent);
  font-size: 14px;
}
.close-btn {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.close-btn:hover {
  color: var(--text);
}
.popup-body {
  font-size: 13px;
  color: var(--text);
  line-height: 1.4;
}
.popup-actions {
  display: flex;
  gap: 10px;
}
.popup-actions button {
  flex: 1;
  padding: 8px 12px;
  font-size: 13px;
  border-radius: 6px;
  font-weight: 500;
}
.accept-btn {
  background: var(--accent);
  color: #fff;
}
.accept-btn:hover {
  background-color: #3b74e6;
}
.reject-btn {
  background: rgba(255, 93, 93, 0.15);
  color: var(--danger);
  border: 1px solid rgba(255, 93, 93, 0.3) !important;
}
.reject-btn:hover {
  background: var(--danger);
  color: #fff;
}

/* Transition animations */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(20px) scale(0.95);
  opacity: 0;
}

/* Table overrides */
.danger-text {
  color: var(--danger);
  border-color: rgba(255, 93, 93, 0.3) !important;
}
.danger-text:hover {
  background-color: rgba(255, 93, 93, 0.1) !important;
}

/* Mobile responsive styles */
@media (max-width: 960px) {
  .studio-layout {
    flex-direction: column;
    align-items: stretch;
  }
  .studio-right {
    width: 100%;
  }
  .chat-panel {
    height: 380px;
  }
}
</style>
