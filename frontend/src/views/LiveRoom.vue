<template>
  <div class="page">
    <!-- 密码 -->
    <div v-if="needPassword" class="modal-bg">
      <div class="modal form-grid">
        <h3>该直播间需要密码</h3>
        <input v-model="password" type="password" placeholder="直播间密码" @keyup.enter="enter" />
        <button @click="enter">进入</button>
        <p v-if="error" style="color:var(--danger)">{{ error }}</p>
      </div>
    </div>

    <template v-if="info">
      <div class="row" style="margin-bottom:10px">
        <span class="tag" :class="{ live: info.room.is_live }">{{ info.room.is_live ? '直播中' : '未开播' }}</span>
        <h2 style="margin:0">{{ info.room.title }}</h2>
        <span class="muted">主播：{{ info.room.owner_name }}</span>
        <span class="tag ok">TRTC</span>
      </div>

      <div class="live-layout">
        <div style="flex:1;min-width:0">
          <!-- 主播画面（TRTC 渲染容器） -->
          <div ref="player" class="trtc-main"></div>
          <p v-if="trtcError" style="color:var(--danger)">{{ trtcError }}</p>
          <!-- 连麦小窗 -->
          <div class="row" style="margin-top:8px">
            <div v-for="m in micStreams" :key="m.micId" style="width:200px">
              <div :ref="(el) => setMicEl(m.rtc_user_id, el)" class="trtc-mic"></div>
              <div class="muted">🎤 {{ m.username }}{{ m.rtc_user_id === myRtcUserId ? '（我）' : '' }}</div>
            </div>
          </div>
          <div class="row" style="margin-top:8px">
            <template v-if="auth.loggedIn && info.room.is_live">
              <button v-if="micState === 'idle'" @click="requestMic">申请连麦</button>
              <span v-else-if="micState === 'requested'" class="tag warn">等待主播同意...</span>
              <button v-else-if="micState === 'publishing'" class="danger" @click="endMic">结束连麦</button>
            </template>
          </div>
          <p class="muted">{{ info.room.description }}</p>
        </div>

        <!-- 聊天 -->
        <div class="chat-panel">
          <div class="chat-msgs" ref="msgBox">
            <div v-for="(m, i) in messages" :key="i" :class="{ sys: m.sys }">
              <template v-if="m.sys">{{ m.text }}</template>
              <template v-else><strong>{{ m.username }}：</strong>{{ m.content }}</template>
            </div>
          </div>
          <div class="row" style="padding:10px">
            <input v-model="chatInput" :placeholder="auth.loggedIn ? '发送消息...' : '登录后可发言'"
              :disabled="!auth.loggedIn" @keyup.enter="sendChat" />
            <button :disabled="!auth.loggedIn" @click="sendChat">发送</button>
          </div>
        </div>
      </div>
    </template>
    <p v-else-if="error" style="color:var(--danger)">{{ error }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { useAuth } from '../store';
import { createWS } from '../ws';
import { createTrtc, enterRoom, exitRoom, TRTC, trtcErrorText } from '../trtc';
import { ensureCapture, captureErrorText } from '../media';

const route = useRoute();
const auth = useAuth();
const roomId = route.params.id;

const info = ref(null), error = ref(''), needPassword = ref(false), password = ref('');
const trtcError = ref('');
const player = ref(null), msgBox = ref(null);
const messages = ref([]), chatInput = ref('');
const micState = ref('idle'); // idle/requested/publishing
const micStreams = ref([]);
const myRtcUserId = ref('');

let trtc = null, inRoom = false, ws = null, myMicId = null;
const micEls = new Map();          // rtc_user_id -> 容器元素
const remoteVideos = new Map();    // `${userId}|${streamType}` -> true（已 available 待渲染/已渲染）

function sys(text) {
  messages.value.push({ sys: true, text });
  scrollChat();
}
function scrollChat() {
  nextTick(() => { if (msgBox.value) msgBox.value.scrollTop = msgBox.value.scrollHeight; });
}

function isAnchorUser(userId) {
  return info.value && info.value.anchor_user_ids.includes(userId);
}

// 渲染远端画面：主播 → 主窗口（屏幕共享 sub 流同样进主窗口）；连麦者 → 小窗
async function renderRemote(userId, streamType) {
  if (!trtc) return;
  try {
    if (isAnchorUser(userId)) {
      await trtc.startRemoteVideo({ userId, streamType, view: player.value });
    } else {
      const el = micEls.get(userId);
      if (el) await trtc.startRemoteVideo({ userId, streamType, view: el });
    }
  } catch (e) { sys(`画面拉取失败(${userId}): ${trtcErrorText(e)}`); }
}

function bindTrtcEvents() {
  trtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, ({ userId, streamType }) => {
    remoteVideos.set(`${userId}|${streamType}`, true);
    renderRemote(userId, streamType);
  });
  trtc.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, ({ userId, streamType }) => {
    remoteVideos.delete(`${userId}|${streamType}`);
    trtc.stopRemoteVideo({ userId, streamType }).catch(() => {});
  });
  // 远端音频默认自动播放；被浏览器自动播放策略拦截时 SDK 弹默认提示框引导点击恢复
}

async function joinTrtcRoom() {
  if (!info.value || !info.value.trtc || inRoom) return;
  trtcError.value = '';
  try {
    trtc = createTrtc();
    bindTrtcEvents();
    await enterRoom(trtc, info.value.trtc);
    inRoom = true;
    myRtcUserId.value = info.value.trtc.user_id;
  } catch (e) {
    trtcError.value = `连接直播失败: ${trtcErrorText(e)}`;
    trtc = null;
  }
}

async function leaveTrtcRoom() {
  if (trtc) { await exitRoom(trtc); trtc = null; }
  inRoom = false;
  remoteVideos.clear();
}

function setMicEl(rtcUserId, el) {
  if (!el || micEls.get(rtcUserId) === el) return;
  micEls.set(rtcUserId, el);
  // 元素就绪后，渲染已 available 的远端流
  for (const key of remoteVideos.keys()) {
    const [uid, st] = key.split('|');
    if (uid === rtcUserId) renderRemote(uid, st);
  }
}

async function enter() {
  error.value = '';
  try {
    info.value = await api(`/live/rooms/${roomId}/watch`, { method: 'POST', body: { password: password.value } });
    needPassword.value = false;
    micStreams.value = info.value.mic_streams || [];
    if (info.value.trtc_error) trtcError.value = info.value.trtc_error;
    const history = await api(`/live/rooms/${roomId}/messages`);
    messages.value = history.map((m) => ({ username: m.username, content: m.content }));
    setupWS();
    if (info.value.room.is_live) nextTick(joinTrtcRoom);
  } catch (e) {
    if (e.data && e.data.reason === 'password') { needPassword.value = true; if (password.value) error.value = '密码错误'; }
    else error.value = e.message;
  }
}

async function enterRefresh() {
  info.value = await api(`/live/rooms/${roomId}/watch`, { method: 'POST', body: { password: password.value } });
  micStreams.value = info.value.mic_streams || [];
  if (info.value.room.is_live) nextTick(joinTrtcRoom);
}

function setupWS() {
  ws = createWS();
  ws.send({ type: 'join', roomId, password: password.value });
  ws.on((msg) => {
    if (msg.scope === 'room') {
      if (msg.type === 'chat.message') { messages.value.push({ username: msg.username, content: msg.content }); scrollChat(); }
      else if (msg.type === 'room.user.joined') sys(`${msg.username} 进入直播间`);
      else if (msg.type === 'room.user.left') sys(`${msg.username} 离开直播间`);
      else if (msg.type === 'live.started') { sys('直播开始了'); enterRefresh(); }
      else if (msg.type === 'live.stopped') { sys(msg.cut ? '直播已被管理员断流' : '直播已结束'); stopMyMic(); leaveTrtcRoom(); }
      else if (msg.type === 'mic.live') {
        if (!micStreams.value.some((m) => m.micId === msg.micId)) {
          micStreams.value.push({ micId: msg.micId, username: msg.username, rtc_user_id: msg.rtc_user_id });
        }
        sys(`${msg.username} 开始连麦`);
      } else if (msg.type === 'mic.ended') {
        micStreams.value = micStreams.value.filter((m) => m.micId !== msg.micId);
        micEls.delete(msg.rtc_user_id);
        if (msg.micId === myMicId) stopMyMic();
        sys(`${msg.username} 结束连麦`);
      }
    }
    if (msg.scope === 'personal') {
      if (msg.type === 'mic.approved' && msg.micId === myMicId) startPublishMic();
      if (msg.type === 'mic.rejected' && msg.micId === myMicId) { micState.value = 'idle'; sys('主播拒绝了你的连麦请求'); }
    }
  });
}

function sendChat() {
  const content = chatInput.value.trim();
  if (!content) return;
  ws.send({ type: 'chat', roomId, content });
  chatInput.value = '';
}

async function requestMic() {
  if (!ensureCapture()) return; // 连麦需要 HTTPS 安全上下文才能采集摄像头
  if (!inRoom) { sys('尚未连接直播（TRTC 未配置或进房失败），无法连麦'); return; }
  try {
    const r = await api(`/live/rooms/${roomId}/mic/request`, { method: 'POST', body: { password: password.value } });
    myMicId = r.micId;
    micState.value = 'requested';
    sys('已发送连麦请求，等待主播同意');
  } catch (e) { sys(`连麦请求失败: ${e.message}`); }
}

// 主播已同意：切换为 anchor 发布本地音视频，然后上报 live
async function startPublishMic() {
  if (!ensureCapture()) { micState.value = 'idle'; return; }
  try {
    await trtc.switchRole(TRTC.TYPE.ROLE_ANCHOR);
    await trtc.startLocalAudio();
    try {
      const el = micEls.get(myRtcUserId.value);
      await trtc.startLocalVideo(el ? { view: el } : undefined);
    } catch (e) {
      sys(`⚠️ 摄像头不可用（${captureErrorText(e)}），已降级为仅语音`);
    }
    await api(`/live/rooms/${roomId}/mic/${myMicId}/live`, { method: 'POST' });
    micState.value = 'publishing';
    sys('连麦已接通，你的音视频正在推送');
  } catch (e) {
    micState.value = 'idle';
    try { await trtc.switchRole(TRTC.TYPE.ROLE_AUDIENCE); } catch { /* 忽略 */ }
    sys(`连麦推流失败: ${trtcErrorText(e)}`);
  }
}

async function stopMyMic() {
  if (micState.value === 'idle') return;
  micState.value = 'idle';
  if (trtc && inRoom) {
    try { await trtc.stopLocalVideo(); } catch { /* 忽略 */ }
    try { await trtc.stopLocalAudio(); } catch { /* 忽略 */ }
    try { await trtc.switchRole(TRTC.TYPE.ROLE_AUDIENCE); } catch { /* 忽略 */ }
  }
}

async function endMic() {
  if (myMicId) await api(`/live/rooms/${roomId}/mic/${myMicId}/end`, { method: 'POST' }).catch(() => {});
  await stopMyMic();
}

onMounted(enter);
onBeforeUnmount(async () => {
  await stopMyMic();
  await leaveTrtcRoom();
  if (ws) { ws.send({ type: 'leave', roomId }); ws.close(); }
});
</script>

<style scoped>
.trtc-main {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}
.trtc-mic {
  width: 100%;
  aspect-ratio: 4 / 3;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
}
</style>
