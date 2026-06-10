FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* .npmrc* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# 自签证书：摄像头/屏幕共享(getUserMedia)要求 HTTPS 安全上下文
RUN apk add --no-cache openssl && mkdir -p /etc/nginx/certs && \
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout /etc/nginx/certs/lvs.key -out /etc/nginx/certs/lvs.crt \
      -subj "/CN=lan-video-station"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443
