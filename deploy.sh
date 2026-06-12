#!/usr/bin/env bash
# 一键部署：将当前目录代码经 SFTP 上传到远端服务器并重建 Docker 服务
# 用法: REMOTE_SSH_PASSWORD=xxx ./deploy.sh [host] [remote_dir]
# 依赖: sshpass、tar（本机）；docker compose（远端）
set -euo pipefail

HOST="${1:-106.52.30.242}"
USER="root"
DIR="${2:-/root/lvs-trtc}"
PASS="${REMOTE_SSH_PASSWORD:?请设置环境变量 REMOTE_SSH_PASSWORD}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=15)

run() { sshpass -p "$PASS" ssh "${SSH_OPTS[@]}" "$USER@$HOST" "$@"; }

echo "[1/5] 打包代码（排除 .git/node_modules/dist/.env，远端 .env 不会被覆盖）"
TARBALL=$(mktemp /tmp/lvs-deploy.XXXXXX.tgz)
tar czf "$TARBALL" \
  --exclude=.git --exclude='*/node_modules' --exclude='*/dist' \
  --exclude=.env --exclude=deploy.sh \
  -C "$(dirname "$0")" .

echo "[2/5] SFTP 上传"
sshpass -p "$PASS" sftp "${SSH_OPTS[@]}" "$USER@$HOST" <<EOF
put $TARBALL /root/lvs-deploy.tgz
EOF
rm -f "$TARBALL"

echo "[3/5] 替换 $DIR 代码"
run "mkdir -p '$DIR' && tar xzf /root/lvs-deploy.tgz -C '$DIR' && rm -f /root/lvs-deploy.tgz"

echo "[4/5] SSL 证书：优先复用服务器上的真实证书（镜像内默认是自签证书）"
run bash -s <<'EOS'
set -e
DIR=/root/lvs-trtc
if [ -f "$DIR/docker-compose.override.yml" ]; then
  echo "  已存在 docker-compose.override.yml，保留现有证书配置"
  exit 0
fi
# 常见证书位置：宝塔面板 / Let's Encrypt / 项目 certs 目录
for pair in \
  "/www/server/panel/vhost/cert/video.haiyanfl.cn/fullchain.pem /www/server/panel/vhost/cert/video.haiyanfl.cn/privkey.pem" \
  "/etc/letsencrypt/live/video.haiyanfl.cn/fullchain.pem /etc/letsencrypt/live/video.haiyanfl.cn/privkey.pem" \
  "$DIR/certs/fullchain.pem $DIR/certs/privkey.pem"; do
  set -- $pair
  if [ -f "$1" ] && [ -f "$2" ]; then
    cat > "$DIR/docker-compose.override.yml" <<EOF
# 自动生成：把服务器上的真实 SSL 证书挂载进 web 容器，覆盖镜像内自签证书
services:
  web:
    volumes:
      - $1:/etc/nginx/certs/lvs.crt:ro
      - $2:/etc/nginx/certs/lvs.key:ro
EOF
    echo "  使用真实证书: $1"
    exit 0
  fi
done
echo "  未找到真实证书，沿用镜像内自签证书（浏览器会提示不安全；如有证书请放到 $DIR/certs/ 后重跑）"
EOS

echo "[5/5] 重建并启动服务（数据库迁移随后端启动自动执行）"
run "cd '$DIR' && (docker compose up -d --build || docker-compose up -d --build)"

echo "健康检查："
run "sleep 8 && (curl -sk https://localhost/api/health || curl -s http://localhost/api/health)" && echo && echo "部署完成 ✔"
