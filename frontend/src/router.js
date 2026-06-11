import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './store';

const routes = [
  { path: '/', component: () => import('./views/Home.vue') },
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/register', component: () => import('./views/Register.vue') },
  { path: '/upload', component: () => import('./views/Upload.vue'), meta: { auth: true } },
  { path: '/video/:id', component: () => import('./views/VideoDetail.vue') },
  { path: '/collections', component: () => import('./views/Collections.vue'), meta: { auth: true } },
  { path: '/collection/:id', component: () => import('./views/CollectionDetail.vue') },
  { path: '/live', component: () => import('./views/LiveList.vue') },
  { path: '/live/:id', component: () => import('./views/LiveRoom.vue') },
  { path: '/studio/:id', component: () => import('./views/Studio.vue'), meta: { auth: true } },
  { path: '/user/:id', component: () => import('./views/Creator.vue') },
  { path: '/chat', component: () => import('./views/Chat.vue'), meta: { auth: true } },
  { path: '/developer', component: () => import('./views/Developer.vue') },
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { auth: true } },
  { path: '/admin', component: () => import('./views/Admin.vue'), meta: { auth: true, admin: true } }
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  const auth = useAuth();
  if (to.meta.auth && !auth.loggedIn) return '/login';
  if (to.meta.admin && !auth.isAdmin) return '/';
});

export default router;
