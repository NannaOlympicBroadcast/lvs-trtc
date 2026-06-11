<template>
  <div class="page" style="max-width:760px">
    <h2>个人设置</h2>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>个人资料</h3>
      <div class="row">
        <input v-model="nickname" placeholder="显示昵称（留空则显示用户名）" style="max-width:260px" />
        <button @click="saveProfile">保存昵称</button>
        <span v-if="profileMsg" class="tag ok">{{ profileMsg }}</span>
      </div>
      <label class="row" style="gap:6px">
        <input type="checkbox" style="width:auto" v-model="popupOn" @change="togglePopup" />
        新聊天消息右下角弹窗提醒
      </label>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>修改密码</h3>
      <input v-model="pwd.old_password" type="password" placeholder="旧密码" autocomplete="current-password" />
      <input v-model="pwd.new_password" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" />
      <input v-model="pwd.confirm" type="password" placeholder="确认新密码" autocomplete="new-password" />
      <div class="row">
        <button @click="changePassword">修改密码</button>
        <span v-if="pwdMsg" class="tag" :class="pwdOk ? 'ok' : 'warn'">{{ pwdMsg }}</span>
      </div>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>API Key</h3>
      <p class="muted">使用 <code>X-API-Key: lvs_xxx</code> 或 <code>Authorization: Bearer lvs_xxx</code> 调用全部 API。</p>
      <div class="row">
        <input v-model="keyName" placeholder="Key 名称" style="max-width:200px" />
        <button @click="createKey">创建 API Key</button>
      </div>
      <p v-if="newKey" style="color:var(--ok)">已创建（仅显示一次，请保存）：<code>{{ newKey }}</code></p>
      <table v-if="keys.length">
        <tr><th>名称</th><th>Key</th><th>最后使用</th><th></th></tr>
        <tr v-for="k in keys" :key="k.id">
          <td>{{ k.name }}</td>
          <td><code>{{ k.token_preview }}</code></td>
          <td class="muted">{{ k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '从未' }}</td>
          <td><button class="ghost" @click="delKey(k)">删除</button></td>
        </tr>
      </table>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>🤖 让你的 Agent（Claude、Codex、Antigravity、Manus、OpenClaw 等）操作站点</h3>
      <p class="muted">
        本站全部功能（上传/审核/直播/连麦/管理）均开放 API，接口说明见
        <a :href="agentsDocUrl" target="_blank"><code>{{ agentsDocUrl }}</code></a>。
        在上方创建 API Key 后，将以下内容发送给你的 Agent：
      </p>
      <textarea readonly rows="3" :value="agentPrompt" style="font-family:monospace"></textarea>
      <div class="row">
        <button @click="copyAgentPrompt">复制提示词</button>
        <span v-if="copied" class="tag ok">已复制</span>
      </div>
      <p v-if="!newKey" class="muted">提示：API Key 完整值仅在创建时显示一次；上面模板中的 Key 占位符需替换为你保存的真实 Key。</p>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>事件 Webhook</h3>
      <p class="muted">
        可监听: video.uploaded, video.review.approved, video.review.rejected, video.taken_down,
        video.comment.created, account.banned, live.started, live.stopped, mic.requested 等。
        留空 = 全部。POST JSON，带 <code>X-LVS-Event</code> 与 <code>X-LVS-Signature</code>(HMAC-SHA256) 头。
        也可直接连接 WebSocket：<code>ws://站点/ws?token=&lt;JWT 或 API Key&gt;</code>
      </p>
      <input v-model="whForm.url" placeholder="回调 URL" />
      <input v-model="whForm.secret" placeholder="签名密钥（可选）" />
      <input v-model="whForm.events" placeholder="事件列表，逗号分隔（留空=全部）" />
      <button @click="addWebhook">添加 Webhook</button>
      <table v-if="webhooks.length">
        <tr><th>URL</th><th>事件</th><th>启用</th><th></th></tr>
        <tr v-for="w in webhooks" :key="w.id">
          <td><code>{{ w.url }}</code></td>
          <td>{{ w.events.length ? w.events.join(', ') : '全部' }}</td>
          <td><input type="checkbox" :checked="w.enabled" @change="toggle(w, $event)" style="width:auto" /></td>
          <td><button class="ghost" @click="delWebhook(w)">删除</button></td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h3>最近事件</h3>
      <table>
        <tr><th>时间</th><th>类型</th><th>内容</th></tr>
        <tr v-for="e in events" :key="e.id">
          <td class="muted">{{ new Date(e.created_at).toLocaleString() }}</td>
          <td><span class="tag">{{ e.type }}</span></td>
          <td class="muted" style="word-break:break-all">{{ JSON.stringify(e.payload).slice(0, 120) }}</td>
        </tr>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { useAuth } from '../store';

const auth = useAuth();
const nickname = ref(auth.user && auth.user.nickname || '');
const profileMsg = ref('');
const popupOn = ref(localStorage.getItem('lvs_chat_popup') !== 'off');
const pwd = ref({ old_password: '', new_password: '', confirm: '' });
const pwdMsg = ref(''), pwdOk = ref(false);

async function saveProfile() {
  const { user } = await api('/auth/profile', { method: 'PATCH', body: { nickname: nickname.value } });
  auth.setSession(auth.token, { ...auth.user, ...user });
  profileMsg.value = '已保存';
  setTimeout(() => { profileMsg.value = ''; }, 2000);
}

function togglePopup() {
  localStorage.setItem('lvs_chat_popup', popupOn.value ? 'on' : 'off');
}

async function changePassword() {
  pwdOk.value = false;
  if (!pwd.value.new_password || pwd.value.new_password.length < 6) { pwdMsg.value = '新密码至少 6 位'; return; }
  if (pwd.value.new_password !== pwd.value.confirm) { pwdMsg.value = '两次输入的新密码不一致'; return; }
  try {
    await api('/auth/password', {
      method: 'POST',
      body: { old_password: pwd.value.old_password, new_password: pwd.value.new_password }
    });
    pwdOk.value = true;
    pwdMsg.value = '密码已修改';
    pwd.value = { old_password: '', new_password: '', confirm: '' };
  } catch (e) { pwdMsg.value = e.message; }
}

const keys = ref([]), newKey = ref(''), keyName = ref('');
const webhooks = ref([]), events = ref([]);
const whForm = ref({ url: '', secret: '', events: '' });
const copied = ref(false);

// Agent 接入：提示词模板（刚创建的 Key 自动填入，否则留占位符）
const agentsDocUrl = computed(() => `${location.origin}/agents.md`);
const agentPrompt = computed(() =>
  `请阅读\`${agentsDocUrl.value}\`，然后执行_____操作，你的api-key为\`${newKey.value || '<你的API-KEY>'}\``);

async function copyAgentPrompt() {
  try {
    await navigator.clipboard.writeText(agentPrompt.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch { alert('复制失败，请手动选择文本复制'); }
}

async function load() {
  keys.value = await api('/keys');
  webhooks.value = await api('/me/webhooks');
  events.value = await api('/me/webhooks/events');
}

async function createKey() {
  const k = await api('/keys', { method: 'POST', body: { name: keyName.value || 'default' } });
  newKey.value = k.token;
  load();
}
async function delKey(k) { await api(`/keys/${k.id}`, { method: 'DELETE' }); load(); }

async function addWebhook() {
  await api('/me/webhooks', {
    method: 'POST',
    body: {
      url: whForm.value.url,
      secret: whForm.value.secret,
      events: whForm.value.events ? whForm.value.events.split(',').map((s) => s.trim()).filter(Boolean) : []
    }
  });
  whForm.value = { url: '', secret: '', events: '' };
  load();
}
async function toggle(w, e) {
  await api(`/me/webhooks/${w.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
}
async function delWebhook(w) { await api(`/me/webhooks/${w.id}`, { method: 'DELETE' }); load(); }

onMounted(load);
</script>
