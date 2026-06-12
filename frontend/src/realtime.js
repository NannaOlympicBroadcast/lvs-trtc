// 全站共享的个人事件 WebSocket 单例（聊天弹窗/消息页共用，避免每个组件各开一条连接）
import { createWS } from './ws';

let ws = null;

export function getRealtimeWS() {
  if (!ws) ws = createWS();
  return ws;
}

export function closeRealtimeWS() {
  if (ws) { ws.close(); ws = null; }
}
