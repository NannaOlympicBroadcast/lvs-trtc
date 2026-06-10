// 腾讯云 TRTC Web SDK (trtc-sdk-v5) 封装
// 房间号使用后端下发的字符串房间号（strRoomId = 直播间 stream_key），
// 与 OBS「RTMP 推流进房」互通（RTMP 进房仅支持字符串房间号）。
import TRTC from 'trtc-sdk-v5';

export { TRTC };

export function createTrtc() {
  return TRTC.create();
}

// params: 后端 enterRoomParams 下发的 { sdk_app_id, str_room_id, user_id, user_sig, role }
export async function enterRoom(trtc, params, roleOverride) {
  const role = (roleOverride || params.role) === 'anchor' ? TRTC.TYPE.ROLE_ANCHOR : TRTC.TYPE.ROLE_AUDIENCE;
  await trtc.enterRoom({
    sdkAppId: params.sdk_app_id,
    strRoomId: params.str_room_id,
    userId: params.user_id,
    userSig: params.user_sig,
    scene: TRTC.TYPE.SCENE_LIVE,
    role
  });
}

export async function exitRoom(trtc) {
  if (!trtc) return;
  try { await trtc.exitRoom(); } catch { /* 已退出/未进房则忽略 */ }
}

// TRTC 错误转中文提示
export function trtcErrorText(e) {
  if (!e) return '未知错误';
  const msg = e.message || String(e);
  if (e.name === 'NotAllowedError') return '浏览器或系统拒绝了摄像头/麦克风权限';
  if (e.name === 'NotReadableError') return '摄像头/麦克风被其他程序占用';
  if (/INVALID_PARAMETER|userSig/i.test(msg)) return `进房参数错误（检查 TRTC 凭证配置）: ${msg}`;
  return msg;
}
