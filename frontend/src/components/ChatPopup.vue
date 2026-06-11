<template>
  <!-- 右下角新消息弹窗（可关闭；localStorage 记住偏好，设置页可重新开启） -->
  <div class="chat-popups">
    <div v-for="t in toasts" :key="t.key" class="chat-popup card">
      <div class="row" style="justify-content:space-between">
        <strong>{{ t.title }}</strong>
        <button class="ghost" style="padding:2px 8px" @click="dismiss(t)">✕</button>
      </div>
      <p class="muted" style="margin:6px 0">{{ t.preview }}</p>
      <div class="row">
        <button style="padding:5px 12px" @click="open(t)">查看</button>
        <a class="muted" style="cursor:pointer;font-size:12px" @click="disablePopup">不再弹窗</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../store';
import { getRealtimeWS } from '../realtime';

const router = useRouter();
const auth = useAuth();
const toasts = ref([]);
let off = null;
let seq = 0;

function popupEnabled() { return localStorage.getItem('lvs_chat_popup') !== 'off'; }

function dismiss(t) { toasts.value = toasts.value.filter((x) => x.key !== t.key); }
function open(t) { dismiss(t); router.push(`/chat?c=${t.conversationId}`); }
function disablePopup() {
  localStorage.setItem('lvs_chat_popup', 'off');
  toasts.value = [];
}

onMounted(() => {
  off = getRealtimeWS().on((msg) => {
    if (msg.type !== 'chat.message.new' || msg.scope !== 'personal') return;
    if (!popupEnabled()) return;
    if (router.currentRoute.value.path === '/chat') return; // 已在消息页则不弹
    const m = msg.message || {};
    // 自己发出的消息（多标签页同步）不弹
    if (auth.user && m.sender_id === auth.user.id) return;
    const isSystem = msg.conversationType === 'system';
    const fromName = msg.from ? (msg.from.nickname || msg.from.username) : '系统消息';
    const t = {
      key: ++seq,
      conversationId: msg.conversationId,
      title: isSystem ? '📢 系统消息' : `💬 ${fromName}`,
      // 端到端加密消息不在弹窗里解密展示，只提示有新消息
      preview: m.encrypted ? '[加密消息] 点击查看' : String(m.content || '').slice(0, 80)
    };
    toasts.value.push(t);
    if (toasts.value.length > 3) toasts.value.shift();
    setTimeout(() => dismiss(t), 8000);
  });
});
onBeforeUnmount(() => { if (off) off(); });
</script>

<style scoped>
.chat-popups {
  position: fixed; right: 16px; bottom: 16px; z-index: 200;
  display: flex; flex-direction: column; gap: 10px; max-width: 320px;
}
.chat-popup { border: 1px solid #2b3242; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
</style>
