# Исполнитель ИИ Kayospace: официальный Claude Code + цикл, который берёт задачи с хаба.
# Сборка из корня репозитория:
#   docker build -f deploy/ai-worker.Dockerfile -t kayospace-ai-worker .
# Вход в аккаунт — переменной CLAUDE_CODE_OAUTH_TOKEN (её выдаёт `claude setup-token`).
FROM node:22-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/model/package.json packages/model/
COPY packages/board/package.json packages/board/
COPY packages/sync/package.json packages/sync/
COPY server/hub/package.json server/hub/
RUN pnpm install --filter "@kayospace/hub..." --prod --no-frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/model packages/model
COPY packages/board packages/board
COPY packages/sync packages/sync
COPY server/hub server/hub

# Claude Code хранит настройки в домашней папке — она у пользователя node своя.
USER node
ENV NODE_ENV=production \
    HOME=/home/node \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_BIN=claude

WORKDIR /app/server/hub
CMD ["./node_modules/.bin/tsx", "src/worker-main.ts"]
