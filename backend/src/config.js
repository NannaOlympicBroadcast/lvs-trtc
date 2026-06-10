'use strict';

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://lvs:lvs_password@localhost:5432/lvs',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev_jwt_secret',
  jwtExpires: '7d',
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || 'lvsminio',
    secretKey: process.env.MINIO_SECRET_KEY || 'lvsminio_secret'
  },
  buckets: { videos: 'videos', thumbnails: 'thumbnails', subtitles: 'subtitles', recordings: 'recordings' },
  // 对外地址（观众浏览器可达）
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost').replace(/\/$/, ''),
  // 腾讯云 TRTC（直播/连麦）：控制台创建应用后填入；未配置时直播相关接口返回明确错误
  trtc: {
    sdkAppId: process.env.TRTC_SDK_APP_ID ? parseInt(process.env.TRTC_SDK_APP_ID, 10) : 0,
    secretKey: process.env.TRTC_SECRET_KEY || '',
    sigExpire: parseInt(process.env.TRTC_SIG_EXPIRE || String(7 * 86400), 10) // UserSig 有效期（秒）
  },
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin12345'
  },
  uploadLimitBytes: 4 * 1024 * 1024 * 1024 // 4GB
};
