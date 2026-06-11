<template>
  <div class="page" style="max-width:860px">
    <h2>🧩 开发者中心</h2>
    <p class="muted">
      本站全部功能（上传/审核/评论/字幕/直播/连麦/聊天反馈/管理）均开放 API，并通过
      WebSocket / Webhook 实时推送事件。你可以据此开发「插件」：一个监听事件并调用 API 的小程序，
      无需改动站点代码即可扩展站点能力。
    </p>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>🤖 让 Claude 帮你写插件</h3>
      <p class="muted">
        我们为 AI Agent 准备了插件开发指南 <a href="/plugin.md" target="_blank"><code>{{ origin }}/plugin.md</code></a>
        （完整 API 参考见 <a href="/agents.md" target="_blank"><code>/agents.md</code></a>）。
        点击下面的按钮，把你想要的插件功能告诉 Claude 即可：
      </p>
      <div class="row">
        <a :href="claudeUrl" target="_blank"><button>点击让 Claude 开发插件</button></a>
        <span class="muted">提示词：阅读 {{ origin }}/plugin.md，并帮我开发一个以下功能的插件：……</span>
      </div>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>1. 准备：创建 API Key</h3>
      <p class="muted">
        前往 <router-link to="/settings">个人设置</router-link> 创建 API Key（<code>lvs_</code> 开头），
        与你的账号同权限。调用方式二选一：
        <code>X-API-Key: lvs_xxx</code> 或 <code>Authorization: Bearer lvs_xxx</code>。
      </p>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>2. 订阅事件：WebSocket 或 Webhook</h3>
      <p class="muted">WebSocket（适合常驻脚本，实时性最好）：</p>
      <pre class="codeblock">const ws = new WebSocket('wss://{{ host }}/ws?token=lvs_你的Key');
ws.onmessage = (e) =&gt; {
  const ev = JSON.parse(e.data);   // { scope, type, time, ...payload }
  if (ev.type === 'video.uploaded') { /* 处理新视频 */ }
};</pre>
      <p class="muted">
        Webhook（适合有公网/局域网可达 HTTP 服务的插件）：在
        <router-link to="/settings">个人设置 → 事件 Webhook</router-link> 填回调 URL，
        事件以 POST JSON 投递，带 <code>X-LVS-Event</code>（类型）与
        <code>X-LVS-Signature</code>（HMAC-SHA256 签名）请求头。
        全部事件类型与 payload schema 见 <a href="/agents.md" target="_blank">/agents.md「事件推送」</a>。
      </p>
    </div>

    <div class="card form-grid" style="margin-bottom:14px">
      <h3>3. 插件示例：视频上传自动添加字幕并审核</h3>
      <p class="muted">
        管理员 Key 监听 <code>admin.video.uploaded</code> 事件 → 下载视频 → 生成字幕（如调用 Whisper）→
        上传字幕 → 自动过审。完整可运行示例与更多模式见 <a href="/plugin.md" target="_blank">/plugin.md</a>。
      </p>
      <pre class="codeblock">// auto-subtitle-plugin.js  (node &gt;= 18)
const BASE = 'https://{{ host }}', KEY = 'lvs_管理员Key';
const H = { 'X-API-Key': KEY };

const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?token=' + KEY);
ws.onmessage = async (e) =&gt; {
  const ev = JSON.parse(e.data);
  if (ev.type !== 'admin.video.uploaded') return;

  // 1) 取播放直链并下载视频
  const { url } = await (await fetch(`${BASE}/api/videos/${ev.videoId}/play?cdn=off`, { headers: H })).json();
  // 2) 生成字幕（示例：调用本地 whisper 服务得到 vtt 文本）
  const vtt = await myWhisper(url);
  // 3) 上传字幕
  const fd = new FormData();
  fd.append('file', new Blob([vtt], { type: 'text/vtt' }), 'auto.vtt');
  fd.append('lang', 'zh'); fd.append('label', '中文（自动）');
  await fetch(`${BASE}/api/videos/${ev.videoId}/subtitles`, { method: 'POST', headers: H, body: fd });
  // 4) 自动过审
  await fetch(`${BASE}/api/admin/videos/${ev.videoId}/approve`, { method: 'POST', headers: H });
};</pre>
    </div>

    <div class="card form-grid">
      <h3>4. 更多插件灵感</h3>
      <ul class="muted" style="margin:0;padding-left:18px;line-height:1.9">
        <li>内容安全机器人：监听 <code>admin.video.uploaded</code> / <code>admin.chat.message</code>，调用内容审核模型自动 <code>reject</code> / <code>takedown</code> / 断流。</li>
        <li>反馈客服机器人：监听 <code>admin.feedback.created</code>，用 LLM 自动答复（<code>POST /api/admin/feedback/:userId/reply</code>）。</li>
        <li>直播通知机器人：监听 <code>live.started</code>，推送到群聊/邮件。</li>
        <li>自动归档：监听 <code>video.review.approved</code>，把视频加入指定收藏夹。</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const origin = location.origin;
const host = location.host;
const claudeUrl = computed(() =>
  `https://claude.ai/code?q=${encodeURIComponent(`阅读${origin}/plugin.md，并帮我开发一个以下功能的插件：`)}`);
</script>

<style scoped>
.codeblock {
  background: var(--panel2); border-radius: 8px; padding: 12px;
  font-size: 12px; overflow-x: auto; white-space: pre; margin: 0;
}
</style>
