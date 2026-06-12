<template>
  <nav class="nav">
    <router-link to="/" class="brand">📺 LAN 视频站</router-link>
    <router-link to="/" class="link">视频</router-link>
    <router-link to="/live" class="link">直播</router-link>
    <router-link v-if="auth.loggedIn" to="/upload" class="link">上传</router-link>
    <router-link v-if="auth.loggedIn" to="/collections" class="link">收藏夹</router-link>
    <router-link v-if="auth.loggedIn" to="/chat" class="link">消息</router-link>
    <router-link to="/developer" class="link">开发者</router-link>
    <span class="spacer"></span>
    <template v-if="auth.loggedIn">
      <router-link v-if="auth.isAdmin" to="/admin" class="link">管理后台</router-link>
      <router-link to="/settings" class="link">设置</router-link>
      <router-link :to="`/user/${auth.user.id}`" class="link">{{ auth.user.nickname || auth.user.username }}</router-link>
      <button class="ghost" @click="logout">退出</button>
    </template>
    <template v-else>
      <router-link to="/login" class="link">登录</router-link>
      <router-link to="/register" class="link">注册</router-link>
    </template>
  </nav>
  <router-view />
  <!-- 登录后挂载全局新消息弹窗（key 跟随用户，切换账号时重建 WS 订阅） -->
  <ChatPopup v-if="auth.loggedIn" :key="auth.user.id" />
</template>

<script setup>
import { watch } from 'vue';
import { useAuth } from './store';
import { useRouter } from 'vue-router';
import ChatPopup from './components/ChatPopup.vue';
import { closeRealtimeWS } from './realtime';

const auth = useAuth();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
// 登录态变化时重置全局 WS（token 在连接建立时携带）
watch(() => auth.token, () => closeRealtimeWS());
</script>
