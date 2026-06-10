FROM node:20-alpine

# ffmpeg/ffprobe: 缩略图、时长探测、直播录制（使用中科大镜像源加速 apk 安装）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories && \
    apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json .npmrc* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
