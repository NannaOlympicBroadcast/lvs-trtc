<template>
  <!-- 私有视频锁定：密码解锁 / 白名单提示 -->
  <div class="page" v-if="locked" style="max-width:560px">
    <div class="card form-grid">
      <h2>🔒 {{ lockedInfo.title }}</h2>
      <p class="muted">{{ lockedInfo.owner_name }} 的私有视频</p>
      <template v-if="lockedInfo.has_password">
        <input v-model="pwd" type="password" placeholder="输入解锁密码" @keyup.enter="unlock" />
        <button @click="unlock">解锁观看</button>
      </template>
      <p class="muted" v-else>该视频未设置解锁密码，仅白名单用户可观看。</p>
      <p class="muted" v-if="!auth.loggedIn">已在白名单中？<router-link to="/login">登录</router-link>后即可直接观看。</p>
      <p v-if="unlockErr" :style="{ color: 'var(--danger)' }">{{ unlockErr }}</p>
    </div>
  </div>

  <div class="page" v-else-if="video" :style="collection ? 'max-width:1280px' : ''">
    <div class="live-layout">
      <div style="flex:1;min-width:0">
        <video ref="player" controls playsinline crossorigin="anonymous">
          <track v-for="s in subtitles" :key="s.id" kind="subtitles" :src="s.url" :srclang="s.lang" :label="s.label" />
        </video>
        <h2 style="margin:10px 0 4px">{{ video.title }}</h2>
        <div class="row muted">
          <router-link :to="`/user/${video.owner_id}`">{{ video.owner_name }}</router-link>
          <span>{{ video.views }} 次观看</span>
          <span v-if="video.visibility === 'private'" class="tag warn">私有</span>
          <span v-if="viaCdn" class="tag ok">CDN: {{ viaCdn }}</span>
          <span class="spacer"></span>
          <a v-if="play" :href="play.download_url" download>下载</a>
          <button class="ghost" v-if="auth.loggedIn" @click="openCollect">⭐ 收藏</button>
          <button class="ghost" v-if="auth.loggedIn" @click="reporting = true">举报</button>
        </div>
        <p>{{ video.description }}</p>

        <!-- 私有视频访问设置（视频主） -->
        <div class="card form-grid" v-if="isOwner && video.visibility === 'private'" style="margin-bottom:14px">
          <strong>私有视频访问设置</strong>
          <div class="row">
            <input v-model="newUnlockPwd" :placeholder="video.has_password ? '已设置解锁密码，输入新密码可修改' : '设置解锁密码（观众凭密码观看）'" style="max-width:300px" />
            <button class="ghost" @click="saveUnlockPwd">保存密码</button>
            <button class="ghost" v-if="video.has_password" @click="clearUnlockPwd">取消密码</button>
          </div>
          <div class="row">
            <input v-model="wlName" placeholder="添加白名单用户名" style="max-width:220px" @keyup.enter="addWhitelist" />
            <button class="ghost" @click="addWhitelist">加入白名单</button>
          </div>
          <div class="row muted" v-if="whitelist.length">
            <span v-for="w in whitelist" :key="w.user_id" class="tag">
              {{ w.username }} <a href="#" @click.prevent="delWhitelist(w)" style="color:var(--danger)">✕</a>
            </span>
          </div>
          <p class="muted" v-else>白名单为空：白名单内的用户登录后可直接观看该视频。</p>
        </div>

        <!-- 添加字幕 -->
        <div class="card" v-if="auth.loggedIn" style="margin-bottom:14px">
          <div class="row">
            <strong>字幕</strong>
            <span class="muted" v-for="s in subtitles" :key="s.id">{{ s.label }}({{ s.lang }})</span>
            <span class="spacer"></span>
            <input ref="subFile" type="file" accept=".vtt,.srt" style="max-width:220px" />
            <input v-model="subLang" placeholder="语言码" style="max-width:90px" />
            <input v-model="subLabel" placeholder="名称" style="max-width:110px" />
            <button class="ghost" @click="uploadSub">上传字幕</button>
          </div>
        </div>

        <!-- 评论 -->
        <div class="card">
          <h3>评论 ({{ comments.length }})</h3>
          <div class="row" v-if="auth.loggedIn" style="margin-bottom:12px">
            <input v-model="newComment" :placeholder="replyTo ? `回复 @${replyTo.username}...` : '发表评论...'" @keyup.enter="postComment" />
            <button @click="postComment">发送</button>
            <button v-if="replyTo" class="ghost" @click="replyTo = null">取消回复</button>
          </div>
          <p v-else class="muted"><router-link to="/login">登录</router-link>后参与评论</p>
          <div v-for="c in topComments" :key="c.id" style="margin-bottom:12px">
            <div><strong>{{ c.display_name || c.username }}</strong> <span class="muted">{{ fmtTime(c.created_at) }}</span></div>
            <div>{{ c.content }}</div>
            <div class="row muted" style="font-size:13px">
              <a href="#" @click.prevent="replyTo = c">回复</a>
              <a href="#" v-if="auth.loggedIn" @click.prevent="reportComment(c)">举报</a>
              <a href="#" v-if="canDelete(c)" @click.prevent="delComment(c)" style="color:var(--danger)">删除</a>
            </div>
            <div v-for="r in repliesOf(c.id)" :key="r.id" style="margin:8px 0 0 24px">
              <div><strong>{{ r.display_name || r.username }}</strong> <span class="muted">{{ fmtTime(r.created_at) }}</span></div>
              <div>{{ r.content }}</div>
              <div class="row muted" style="font-size:13px">
                <a href="#" v-if="auth.loggedIn" @click.prevent="reportComment(r)">举报</a>
                <a href="#" v-if="canDelete(r)" @click.prevent="delComment(r)" style="color:var(--danger)">删除</a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 收藏夹播放列表（从收藏夹进入时显示） -->
      <div class="chat-panel" v-if="collection" style="height:auto;max-height:80vh;align-self:flex-start">
        <div style="padding:12px 12px 8px">
          <strong>📁 {{ collection.name }}</strong>
          <div class="muted">{{ collection.owner_name }} · {{ collection.videos.length }} 个视频</div>
        </div>
        <div class="chat-msgs">
          <router-link v-for="(cv, i) in collection.videos" :key="cv.id"
            :to="`/video/${cv.id}?collection=${collection.id}`"
            class="row" style="padding:6px;border-radius:8px;margin-bottom:4px;flex-wrap:nowrap"
            :style="cv.id === video.id ? 'background:var(--panel2)' : ''">
            <span class="muted" style="min-width:20px">{{ i + 1 }}</span>
            <img v-if="cv.thumbnail_url" :src="cv.thumbnail_url" class="thumb" style="width:90px;min-width:90px" />
            <div v-else class="thumb" style="width:90px;min-width:90px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px">
              {{ cv.locked ? '🔒' : '无封面' }}
            </div>
            <div style="min-width:0">
              <div :style="`font-size:13px;color:${cv.id === video.id ? 'var(--accent)' : 'var(--text)'}`">
                {{ cv.locked ? '🔒 ' : '' }}{{ cv.title }}
              </div>
              <div class="muted" style="font-size:12px">{{ cv.owner_name }}</div>
            </div>
          </router-link>
        </div>
      </div>
    </div>

    <!-- 收藏到收藏夹弹窗 -->
    <div v-if="collecting" class="modal-bg" @click.self="collecting = false">
      <div class="modal form-grid">
        <h3>收藏到收藏夹</h3>
        <p class="muted" v-if="!myCollections.length">还没有收藏夹，先创建一个：</p>
        <div class="row" v-for="c in myCollections" :key="c.id">
          <span style="flex:1">{{ c.name }} <span class="muted">({{ c.video_count }})</span></span>
          <button class="ghost" @click="addToCollection(c)">加入</button>
        </div>
        <div class="row">
          <input v-model="newCollName" placeholder="新建收藏夹名称" @keyup.enter="createAndCollect" />
          <button @click="createAndCollect">创建并收藏</button>
        </div>
        <button class="ghost" @click="collecting = false">关闭</button>
      </div>
    </div>

    <!-- 举报弹窗 -->
    <div v-if="reporting" class="modal-bg" @click.self="reporting = false">
      <div class="modal form-grid">
        <h3>举报{{ reportTarget.type === 'video' ? '视频' : '评论' }}</h3>
        <textarea v-model="reportReason" rows="3" placeholder="举报理由"></textarea>
        <div class="row">
          <button class="danger" @click="submitReport">提交举报</button>
          <button class="ghost" @click="reporting = false">取消</button>
        </div>
      </div>
    </div>
  </div>
  <div class="page" v-else><p class="muted">{{ error || '加载中...' }}</p></div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { useAuth } from '../store';
import { mediaUrl } from '../media';

const route = useRoute();
const auth = useAuth();
const video = ref(null), play = ref(null), viaCdn = ref(null), error = ref('');
const subtitles = ref([]), comments = ref([]);
const newComment = ref(''), replyTo = ref(null);
const reporting = ref(false), reportReason = ref(''), reportTarget = ref({ type: 'video', id: null });
const player = ref(null), subFile = ref(null);
const subLang = ref('zh'), subLabel = ref('中文');

// 私有视频解锁
const locked = ref(false), lockedInfo = ref({}), pwd = ref(''), unlockErr = ref('');
// 视频主私有设置
const newUnlockPwd = ref(''), whitelist = ref([]), wlName = ref('');
// 收藏夹
const collection = ref(null);
const collecting = ref(false), myCollections = ref([]), newCollName = ref('');

const topComments = computed(() => comments.value.filter((c) => !c.parent_id));
const repliesOf = (id) => comments.value.filter((c) => c.parent_id === id);
const fmtTime = (t) => new Date(t).toLocaleString();
const canDelete = (c) => auth.loggedIn && (auth.user.id === c.user_id || auth.isAdmin);
const isOwner = computed(() => auth.loggedIn && video.value && (auth.user.id === video.value.owner_id || auth.isAdmin));

// 解锁密码以 query 透传给详情/播放/字幕/评论接口；按视频记忆在 sessionStorage
const pwdKey = () => `lvs_vpw_${route.params.id}`;
const pq = (sep = '?') => pwd.value ? `${sep}password=${encodeURIComponent(pwd.value)}` : '';

async function load() {
  try {
    error.value = ''; locked.value = false; collection.value = null;
    const id = route.params.id;
    pwd.value = sessionStorage.getItem(pwdKey()) || '';
    const v = await api(`/videos/${id}${pq()}`);
    if (v.locked) {
      locked.value = true; lockedInfo.value = v; pwd.value = '';
      return;
    }
    video.value = v;
    play.value = await api(`/videos/${id}/play${pq()}`);
    viaCdn.value = play.value.via_cdn;
    subtitles.value = await api(`/videos/${id}/subtitles${pq()}`);
    comments.value = await api(`/videos/${id}/comments${pq()}`);
    requestAnimationFrame(() => { if (player.value) player.value.src = mediaUrl(play.value.video_url); });
    loadCollectionPanel();
    if (isOwner.value && v.visibility === 'private') loadWhitelist();
  } catch (e) { error.value = e.message; }
}

async function loadCollectionPanel() {
  if (!route.query.collection) return;
  try { collection.value = await api(`/collections/${route.query.collection}`); }
  catch { collection.value = null; }
}

async function unlock() {
  unlockErr.value = '';
  try {
    const v = await api(`/videos/${route.params.id}?password=${encodeURIComponent(pwd.value)}`);
    if (v.locked) { unlockErr.value = '密码错误'; return; }
    sessionStorage.setItem(pwdKey(), pwd.value);
    await load();
  } catch (e) { unlockErr.value = e.message; }
}

// ---- 视频主：解锁密码 / 白名单 ----
async function saveUnlockPwd() {
  if (!newUnlockPwd.value) return alert('请输入密码');
  await api(`/videos/${video.value.id}`, { method: 'PATCH', body: { unlock_password: newUnlockPwd.value } });
  video.value.has_password = true;
  newUnlockPwd.value = '';
  alert('解锁密码已保存');
}

async function clearUnlockPwd() {
  await api(`/videos/${video.value.id}`, { method: 'PATCH', body: { unlock_password: '' } });
  video.value.has_password = false;
  alert('已取消解锁密码');
}

async function loadWhitelist() {
  whitelist.value = await api(`/videos/${video.value.id}/whitelist`);
}

async function addWhitelist() {
  if (!wlName.value.trim()) return;
  try {
    await api(`/videos/${video.value.id}/whitelist`, { method: 'POST', body: { username: wlName.value.trim() } });
    wlName.value = '';
    loadWhitelist();
  } catch (e) { alert(e.message); }
}

async function delWhitelist(w) {
  await api(`/videos/${video.value.id}/whitelist/${w.user_id}`, { method: 'DELETE' });
  loadWhitelist();
}

// ---- 收藏 ----
async function openCollect() {
  myCollections.value = await api('/collections/mine');
  collecting.value = true;
}

async function addToCollection(c) {
  await api(`/collections/${c.id}/videos`, { method: 'POST', body: { video_id: video.value.id } });
  collecting.value = false;
  alert(`已收藏到「${c.name}」`);
}

async function createAndCollect() {
  if (!newCollName.value.trim()) return;
  const c = await api('/collections', { method: 'POST', body: { name: newCollName.value.trim() } });
  newCollName.value = '';
  await addToCollection(c);
}

async function postComment() {
  if (!newComment.value.trim()) return;
  await api(`/videos/${video.value.id}/comments${pq()}`, {
    method: 'POST',
    body: { content: newComment.value, parent_id: replyTo.value ? replyTo.value.id : undefined }
  });
  newComment.value = ''; replyTo.value = null;
  comments.value = await api(`/videos/${video.value.id}/comments${pq()}`);
}

async function delComment(c) {
  await api(`/videos/${video.value.id}/comments/${c.id}`, { method: 'DELETE' });
  comments.value = await api(`/videos/${video.value.id}/comments${pq()}`);
}

function reportComment(c) {
  reportTarget.value = { type: 'comment', id: c.id };
  reporting.value = true;
}

async function submitReport() {
  if (!reportReason.value.trim()) return;
  await api('/reports', {
    method: 'POST',
    body: {
      target_type: reportTarget.value.type,
      target_id: reportTarget.value.type === 'video' ? video.value.id : reportTarget.value.id,
      reason: reportReason.value
    }
  });
  reporting.value = false; reportReason.value = '';
  reportTarget.value = { type: 'video', id: null };
  alert('举报已提交');
}

async function uploadSub() {
  const f = subFile.value.files[0];
  if (!f) return alert('请选择字幕文件 (.vtt/.srt)');
  const fd = new FormData();
  fd.append('file', f);
  fd.append('lang', subLang.value);
  fd.append('label', subLabel.value);
  await api(`/videos/${video.value.id}/subtitles${pq()}`, { method: 'POST', formData: fd });
  subtitles.value = await api(`/videos/${video.value.id}/subtitles${pq()}`);
  alert('字幕已上传，刷新页面生效');
}

watch(() => route.params.id, () => { if (route.params.id) load(); });
onMounted(load);
</script>
