'use strict';
// 腾讯云 TRTC：UserSig 签发（TLS-Sig-API-v2，HMAC-SHA256）+ 进房参数 / OBS RTMP 推流进房地址
// 参考：Tencent RTC 文档「TRTC UserSig 鉴权」与「RTMP 推流进房」
// 房间号约定：使用直播间 stream_key 作为 TRTC 字符串房间号（strRoomId）。
// 原因：RTMP 推流进房仅支持字符串房间号（≤64 字符，数字/字母/下划线），
// 且房间内其他端也必须以字符串房间号进房才能互通（来源：cloud.tencent.com/document/product/647/102957）。
const crypto = require('crypto');
const zlib = require('zlib');
const config = require('../config');

function trtcEnabled() {
  return !!(config.trtc.sdkAppId && config.trtc.secretKey);
}

// 未配置凭证时给出明确错误（不做降级/mock）
function assertTrtcConfigured() {
  if (!trtcEnabled()) {
    const err = new Error('TRTC 未配置：请在 .env 中设置 TRTC_SDK_APP_ID 与 TRTC_SECRET_KEY（腾讯云 TRTC 控制台获取）后重启服务');
    err.status = 503;
    throw err;
  }
}

// base64 → TLS-Sig-API-v2 约定的 URL 安全变体（+→* /→- =→_）
function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
}

function hmacSha256(sdkAppId, userId, currTime, expire) {
  const raw = `TLS.identifier:${userId}\n`
    + `TLS.sdkappid:${sdkAppId}\n`
    + `TLS.time:${currTime}\n`
    + `TLS.expire:${expire}\n`;
  return crypto.createHmac('sha256', config.trtc.secretKey).update(raw).digest('base64');
}

// 生成 UserSig（官方 tls-sig-api-v2 算法：JSON 文档 zlib 压缩后 base64）
function genUserSig(userId, expire = config.trtc.sigExpire) {
  assertTrtcConfigured();
  const sdkAppId = config.trtc.sdkAppId;
  const currTime = Math.floor(Date.now() / 1000);
  const doc = {
    'TLS.ver': '2.0',
    'TLS.identifier': String(userId),
    'TLS.sdkappid': Number(sdkAppId),
    'TLS.expire': Number(expire),
    'TLS.time': Number(currTime),
    'TLS.sig': hmacSha256(sdkAppId, String(userId), currTime, expire)
  };
  return base64UrlEncode(zlib.deflateSync(Buffer.from(JSON.stringify(doc))));
}

// TRTC 用户 ID 约定：网页端 u<用户id>；OBS RTMP 推流进房 obs<用户id>
function rtcUserId(userId) { return `u${userId}`; }
function obsUserId(userId) { return `obs${userId}`; }

// 进房参数（前端 trtc-sdk-v5 enterRoom 直接使用；strRoomId = 直播间 stream_key）
function enterRoomParams(strRoomId, userId, role) {
  assertTrtcConfigured();
  const uid = rtcUserId(userId);
  return {
    sdk_app_id: Number(config.trtc.sdkAppId),
    str_room_id: String(strRoomId),
    user_id: uid,
    user_sig: genUserSig(uid),
    role // 'anchor' | 'audience'
  };
}

// OBS/FFmpeg 等 RTMP 推流进 TRTC 房间。
// OBS 用法：服务器填 rtmp://rtmp.rtc.qq.com/push/，推流码填 streamKey 部分。
function rtmpPush(strRoomId, userId) {
  assertTrtcConfigured();
  const uid = obsUserId(userId);
  const sig = genUserSig(uid); // base64url 变体仅含字母数字与 * - _，RTMP 推流码中无需转义
  const streamKey = `${strRoomId}?sdkappid=${config.trtc.sdkAppId}&userid=${uid}&usersig=${sig}`;
  return {
    server: 'rtmp://rtmp.rtc.qq.com/push/',
    stream_key: streamKey,
    url: `rtmp://rtmp.rtc.qq.com/push/${streamKey}`
  };
}

module.exports = { trtcEnabled, assertTrtcConfigured, genUserSig, enterRoomParams, rtmpPush, rtcUserId, obsUserId };
