#!/usr/bin/env bash
# Установка и обновление хаба Kayospace на VPS (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/Kayosac/KayoSpace/main/deploy/setup.sh | sudo bash
#
# Повторный запуск обновляет код и перезапускает хаб; токен и данные сохраняются.
# Переменные (необязательно): HUB_DOMAIN — свой домен вместо <IP>.sslip.io, HTTPS_PORT — порт HTTPS
# (по умолчанию 443, а если он занят, например VPN, — 8443), BRANCH, DIR, REPO.
set -euo pipefail

REPO="${REPO:-https://github.com/Kayosac/KayoSpace.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-/opt/kayospace}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "запустите от root: … | sudo bash"

say "1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "нет docker compose — обновите Docker"

say "2/5 Код Kayospace ($BRANCH)"
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq git
fi
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/deploy"

say "3/5 Настройки"

# Занят ли порт кем-то, кроме нашего Caddy (при повторном запуске он сам держит свои порты).
port_busy() {
  ss -Htlnp "sport = :$1" 2>/dev/null | grep -v '"docker-proxy"' | grep -q .
}

if port_busy 80; then
  fail "порт 80 занят: $(ss -Htlnp 'sport = :80' | head -1). Caddy нужен порт 80, чтобы получить сертификат."
fi

if [ ! -f .env ]; then
  IP="$(curl -4fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
  [ -n "$IP" ] || fail "не удалось узнать внешний IP сервера"
  DOMAIN="${HUB_DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  umask 077
  printf 'HUB_DOMAIN=%s\nHUB_TOKEN=%s\n' "$DOMAIN" "$TOKEN" > .env
  echo "Создан deploy/.env"
else
  echo "deploy/.env уже есть — использую его"
fi

if ! grep -q '^HTTPS_PORT=' .env; then
  PORT="${HTTPS_PORT:-}"
  if [ -z "$PORT" ]; then
    PORT=443
    if port_busy 443; then
      echo "Порт 443 занят ($(ss -Htlnp 'sport = :443' | grep -o 'users:(("[^"]*' | cut -d'"' -f2 | head -1)) — не трогаю его."
      for candidate in 8443 9443 10443; do
        if ! port_busy "$candidate"; then PORT="$candidate"; break; fi
      done
      [ "$PORT" != 443 ] || fail "заняты порты 443, 8443, 9443 и 10443 — задайте HTTPS_PORT вручную"
    fi
  fi
  echo "HTTPS_PORT=$PORT" >> .env
  echo "HTTPS будет на порту $PORT"
fi
# shellcheck disable=SC1091
. ./.env
if [ "$HTTPS_PORT" = 443 ]; then
  HUB_ADDR="$HUB_DOMAIN"
  HUB_URL="https://$HUB_DOMAIN"
else
  HUB_ADDR="https://$HUB_DOMAIN:$HTTPS_PORT"
  HUB_URL="https://$HUB_DOMAIN:$HTTPS_PORT"
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow "$HTTPS_PORT/tcp" >/dev/null
  echo "Открыл порты 80 и $HTTPS_PORT в ufw"
fi

say "4/5 Сборка и запуск (первый раз — пара минут)"
docker compose up -d --build --remove-orphans

say "5/5 Жду HTTPS-сертификат и хаб"
OK=""
for _ in $(seq 1 36); do
  if curl -fsS --max-time 5 "$HUB_URL/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done

if [ -z "$OK" ]; then
  echo "Хаб не ответил по $HUB_URL/health за 3 минуты."
  echo "Проверьте, что порты 80 и $HTTPS_PORT открыты в панели провайдера, и посмотрите логи:"
  echo "  cd $DIR/deploy && docker compose logs --tail 50"
  exit 1
fi

cat <<EOF

Готово. Хаб работает: $HUB_URL

  Адрес хаба:  $HUB_ADDR
  Токен:       $HUB_TOKEN

Pen Lab / приложение → Настройки → Синхронизация:
  Хаб:   $HUB_ADDR
  Токен: (строка выше)

Коннектор в приложении Claude (claude.ai, телефон, компьютер):
  Настройки → Коннекторы → Добавить свой коннектор → URL: $HUB_URL/mcp
  → «Подключить» → на странице хаба вставьте токен → «Разрешить»

Claude Code на своём компьютере:
  claude mcp add --transport http kayospace $HUB_URL/mcp --header "Authorization: Bearer $HUB_TOKEN"

ИИ в доске (кнопка «✦ ИИ») на этом сервере — по желанию:
  1) на своём компьютере: claude setup-token  (выдаст токен подписки)
  2) добавьте в $DIR/deploy/.env строки:
       COMPOSE_PROFILES=ai
       CLAUDE_CODE_OAUTH_TOKEN=<токен из шага 1>
  3) cd $DIR/deploy && docker compose up -d --build

Обновить хаб:      повторите команду установки
Логи:              cd $DIR/deploy && docker compose logs -f hub   (ИИ: … logs -f ai-worker)
Резервная копия:   docker run --rm -v kayospace_hub-data:/data -v "\$PWD":/backup alpine tar czf /backup/kayospace-boards.tgz -C /data .
Показать токен:    cat $DIR/deploy/.env
EOF
