# Ennam Motion Studio — image chạy thử/production (Render, Fly.io, Railway, VPS).
# Chromium lấy từ @sparticuz/chromium (cùng bản ghim với golden test) → không cần tải Playwright.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=5173 \
    DATA_DIR=/data \
    FONTCONFIG_PATH=/tmp/fonts

# ffmpeg cho xuất MP4; thư viện tối thiểu để Chromium headless chạy trên Debian
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates fonts-noto-core fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libasound2 libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Cài cả devDependencies vì @sparticuz/chromium nằm ở đó
RUN npm ci --include=dev && npm cache clean --force
COPY . .

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 5173

CMD ["sh", "scripts/docker-start.sh"]
