# Образ хаба Kayospace. Сборка из корня репозитория:
#   docker build -f deploy/hub.Dockerfile -t kayospace-hub .
FROM node:22-alpine

# pnpm ставится в общую папку: `docker compose exec hub pnpm pair` работает от пользователя node
# и не скачивает pnpm заново.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
# Шрифт с кириллицей — для картинки доски, которую видят агенты (view_board, решение 0015).
RUN apk add --no-cache font-dejavu

WORKDIR /app

# Сначала только манифесты — установка зависимостей кешируется, пока они не меняются.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/model/package.json packages/model/
COPY packages/board/package.json packages/board/
COPY packages/sync/package.json packages/sync/
COPY server/hub/package.json server/hub/
RUN pnpm install --filter "@kayospace/hub..." --prod --no-frozen-lockfile \
    && chmod -R a+rX "$COREPACK_HOME"

COPY tsconfig.base.json ./
COPY packages/model packages/model
COPY packages/board packages/board
COPY packages/sync packages/sync
COPY server/hub server/hub

RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1

WORKDIR /app/server/hub
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
