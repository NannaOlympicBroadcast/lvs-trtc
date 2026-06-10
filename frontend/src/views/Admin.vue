<template>
  <div class="page">
    <h2>管理后台</h2>
    <div class="tabs">
      <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="switchTab(t.key)">{{ t.name }}</button>
    </div>

    <!-- 视频审核 -->
    <div v-show="tab === 'review'" class="card">
      <div class="row" style="margin-bottom:10px">
        <label class="row" style="gap:6px">
          <input type="checkbox" style="width:auto" :checked="!reviewRequired" @change="toggleReview" />
          免审模式（公开视频直接上架）
        </label>
        <span class="spacer"></span>
        <select v-model="videoStatus" style="max-width:160px" @change="loadVideos">
          <option value="pending">待审核</option>
          <option value="approved">已上架</option>
          <option value="rejected">已拒绝</option>
          <option value="taken_down">已下架</option>
        </select>
      </div>
      <table>
        <tr><th>标题</th><th>作者</th><th>可见性</th><th>时间</th><th>操作</th></tr>
        <tr v-for="v in videos" :key="v.id">
          <td><router-link :to="`/video/${v.id}`">{{ v.title }}</router-link></td>
          <td>{{ v.owner_name }}</td>
          <td>{{ v.visibility }}</td>
          <td class="muted">{{ new Date(v.created_at).toLocaleString() }}</td>
          <td class="row">
            <button v-if="v.status !== 'approved'" @click="approve(v)">通过</button>
            <button v-if="v.status === 'pending'" class="ghost" @click="reject(v)">拒绝</button>
            <button v-if="v.status === 'approved'" class="danger" @click="takedown(v)">下架</button>
          </td>
        </tr>
      </table>
      <p v-if="!videos.length" class="muted">暂无</p>
    </div>

    <!-- 举报 -->
    <div v-show="tab === 'reports'" class="card">
      <table>
        <tr><th>目标</th><th>理由</th><th>举报人</th><th>时间</th><th>操作</th></tr>
        <tr v-for="r in reports" :key="r.id">
          <td>
            <router-link v-if="r.target_type === 'video'" :to="`/video/${r.target_id}`">视频</router-link>
            <span v-else>评论 #{{ r.target_id }}</span>
          </td>
          <td>{{ r.reason }}</td>
          <td>{{ r.reporter_name }}</td>
          <td class="muted">{{ new Date(r.created_at).toLocaleString() }}</td>
          <td class="row">
            <button @click="resolveReport(r, 'resolved')">已处理</button>
            <button class="ghost" @click="resolveReport(r, 'dismissed')">忽略</button>
          </td>
        </tr>
      </table>
      <p v-if="!reports.length" class="muted">暂无待处理举报</p>
    </div>

    <!-- 用户 -->
    <div v-show="tab === 'users'" class="card">
      <div class="row" style="margin-bottom:10px">
        <input v-model="userQ" placeholder="搜索用户名" style="max-width:240px" @keyup.enter="loadUsers" />
        <button class="ghost" @click="loadUsers">搜索</button>
      </div>
      <table>
        <tr><th>用户</th><th>角色</th><th>封禁状态</th><th>操作</th></tr>
        <tr v-for="u in users" :key="u.id">
          <td><router-link :to="`/user/${u.id}`">{{ u.username }}</router-link></td>
          <td>{{ u.role }}</td>
          <td>
            <span v-if="u.banned_until && new Date(u.banned_until) > new Date()" class="tag warn">
              封禁至 {{ new Date(u.banned_until).toLocaleString() }}（{{ u.ban_reason }}）
            </span>
            <span v-else class="tag ok">正常</span>
          </td>
          <td class="row" v-if="u.role !== 'admin'">
            <button class="danger" @click="ban(u)">封禁</button>
            <button v-if="u.banned_until" class="ghost" @click="unban(u)">解封</button>
          </td><td v-else></td>
        </tr>
      </table>
    </div>

    <!-- 直播间 -->
    <div v-show="tab === 'rooms'" class="card">
      <table>
        <tr><th>直播间</th><th>主播</th><th>状态</th><th>TRTC 房间号</th><th>操作</th></tr>
        <tr v-for="r in rooms" :key="r.id">
          <td><router-link :to="`/live/${r.id}`">{{ r.title }}</router-link></td>
          <td>{{ r.owner_name }}</td>
          <td><span class="tag" :class="{ live: r.is_live }">{{ r.is_live ? '直播中' : '离线' }}</span></td>
          <td class="muted" style="max-width:280px;word-break:break-all"><code>{{ r.stream_key }}</code></td>
          <td><button v-if="r.is_live" class="danger" @click="cut(r)">断流</button></td>
        </tr>
      </table>
    </div>

    <!-- CDN -->
    <div v-show="tab === 'cdn'" class="card form-grid">
      <h3>公网 CDN 节点</h3>
      <p class="muted">公网 CDN（腾讯云 CDN / Cloudflare 等）：源站配置指向本站 <code>/storage/</code> 路径，此处填写其访问域名（如 <code>https://cdn.example.com</code>），点播播放将在启用节点间轮询调度（<code>?cdn=off</code> 强制回源）。</p>
      <div class="row">
        <input v-model="cdnForm.name" placeholder="节点名" style="max-width:160px" />
        <input v-model="cdnForm.base_url" placeholder="https://cdn.example.com" style="max-width:260px" />
        <button @click="addNode">添加节点</button>
        <button class="ghost" @click="checkNodes">健康检查</button>
      </div>
      <table>
        <tr><th>名称</th><th>地址</th><th>启用</th><th>最后心跳</th><th></th></tr>
        <tr v-for="n in nodes" :key="n.id">
          <td>{{ n.name }} <span v-if="health[n.id] !== undefined" class="tag" :class="health[n.id] ? 'ok' : 'warn'">{{ health[n.id] ? '健康' : '不可达' }}</span></td>
          <td><code>{{ n.base_url }}</code></td>
          <td><input type="checkbox" style="width:auto" :checked="n.enabled" @change="toggleNode(n, $event)" /></td>
          <td class="muted">{{ n.last_seen_at ? new Date(n.last_seen_at).toLocaleString() : '-' }}</td>
          <td><button class="ghost" @click="delNode(n)">删除</button></td>
        </tr>
      </table>
    </div>

    <!-- 实时事件 -->
    <div v-show="tab === 'events'" class="card">
      <h3>实时事件流 <span class="tag" :class="wsOk ? 'ok' : 'warn'">{{ wsOk ? 'WebSocket 已连接' : '连接中' }}</span></h3>
      <table>
        <tr><th>时间</th><th>类型</th><th>内容</th></tr>
        <tr v-for="(e, i) in liveEvents" :key="i">
          <td class="muted">{{ e.time ? new Date(e.time).toLocaleTimeString() : '' }}</td>
          <td><span class="tag">{{ e.type }}</span></td>
          <td class="muted" style="word-break:break-all">{{ JSON.stringify(e).slice(0, 160) }}</td>
        </tr>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api';
import { createWS } from '../ws';

const tabs = [
  { key: 'review', name: '视频审核' }, { key: 'reports', name: '举报' },
  { key: 'users', name: '用户' }, { key: 'rooms', name: '直播间' },
  { key: 'cdn', name: 'CDN 节点' }, { key: 'events', name: '实时事件' }
];
const tab = ref('review');
const videos = ref([]), videoStatus = ref('pending'), reviewRequired = ref(true);
const reports = ref([]), users = ref([]), userQ = ref(''), rooms = ref([]), nodes = ref([]);
const cdnForm = ref({ name: '', base_url: '' });
const health = ref({});
const liveEvents = ref([]), wsOk = ref(false);
let ws = null;

function switchTab(k) {
  tab.value = k;
  if (k === 'review') loadVideos();
  if (k === 'reports') loadReports();
  if (k === 'users') loadUsers();
  if (k === 'rooms') loadRooms();
  if (k === 'cdn') loadNodes();
}

async function loadSettings() {
  const s = await api('/admin/settings');
  reviewRequired.value = s.review_required === true || s.review_required === 'true';
}
async function toggleReview(e) {
  const noReview = e.target.checked;
  await api('/admin/settings/review_required', { method: 'PUT', body: { value: !noReview } });
  reviewRequired.value = !noReview;
}

async function loadVideos() { videos.value = await api(`/admin/videos?status=${videoStatus.value}`); }
async function approve(v) { await api(`/admin/videos/${v.id}/approve`, { method: 'POST' }); loadVideos(); }
async function reject(v) {
  const reason = prompt('拒绝理由：'); if (reason === null) return;
  await api(`/admin/videos/${v.id}/reject`, { method: 'POST', body: { reason } }); loadVideos();
}
async function takedown(v) {
  const reason = prompt('下架理由：'); if (!reason) return;
  await api(`/admin/videos/${v.id}/takedown`, { method: 'POST', body: { reason } }); loadVideos();
}

async function loadReports() { reports.value = await api('/admin/reports?status=open'); }
async function resolveReport(r, action) {
  await api(`/admin/reports/${r.id}/resolve`, { method: 'POST', body: { action } }); loadReports();
}

async function loadUsers() { users.value = await api(`/admin/users?q=${encodeURIComponent(userQ.value)}`); }
async function ban(u) {
  const hours = prompt('封禁时长（小时）：', '24'); if (!hours) return;
  const reason = prompt('封禁理由：', '违反社区规定') || '违反社区规定';
  await api(`/admin/users/${u.id}/ban`, { method: 'POST', body: { hours: Number(hours), reason } }); loadUsers();
}
async function unban(u) { await api(`/admin/users/${u.id}/ban`, { method: 'POST', body: { hours: 0 } }); loadUsers(); }

async function loadRooms() { rooms.value = await api('/admin/rooms'); }
async function cut(r) {
  const reason = prompt('断流理由：', '违规直播'); if (reason === null) return;
  await api(`/admin/rooms/${r.id}/cut`, { method: 'POST', body: { reason } });
  setTimeout(loadRooms, 1000);
}

async function loadNodes() { nodes.value = await api('/cdn/nodes'); }
async function addNode() {
  await api('/cdn/nodes', { method: 'POST', body: { ...cdnForm.value } });
  cdnForm.value = { name: '', base_url: '' };
  loadNodes();
}
async function toggleNode(n, e) {
  await api(`/cdn/nodes/${n.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
}
async function delNode(n) { await api(`/cdn/nodes/${n.id}`, { method: 'DELETE' }); loadNodes(); }
async function checkNodes() {
  const results = await api('/cdn/nodes/check', { method: 'POST' });
  health.value = Object.fromEntries(results.map((r) => [r.id, r.healthy]));
}

onMounted(async () => {
  await loadSettings();
  loadVideos();
  ws = createWS();
  ws.on((msg) => {
    if (msg.type === 'hello') { wsOk.value = true; return; }
    if (msg.scope === 'admin' || msg.scope === 'personal') {
      liveEvents.value.unshift(msg);
      if (liveEvents.value.length > 200) liveEvents.value.pop();
    }
  });
});
onBeforeUnmount(() => { if (ws) ws.close(); });
</script>
