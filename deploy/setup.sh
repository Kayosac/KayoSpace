#!/usr/bin/env bash
# Установка и обновление хаба Kayospace на VPS (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/Kayosac/KayoSpace/main/deploy/setup.sh | sudo bash
#
# Ставит последний релиз (vX.Y.Z) и автообновление: дальше хаб сам переходит на новые релизы
# (systemd-таймер kayospace-update, решение 0014). Повторный запуск — то же самое; токен и данные сохраняются.
# Переменные (необязательно): HUB_DOMAIN — свой домен вместо <IP>.sslip.io, HTTPS_PORT — порт HTTPS
# (по умолчанию 443, а если он занят, например VPN, — 8443), BRANCH — ветка вместо релиза (например, main),
# AUTO_UPDATE=0 — без автообновления, DIR, REPO.
set -euo pipefail

REPO="${REPO:-https://github.com/Kayosac/KayoSpace.git}"
DIR="${DIR:-/opt/kayospace}"
API="${API:-https://api.github.com/repos/Kayosac/KayoSpace/releases/latest}"
AUTO_UPDATE="${AUTO_UPDATE:-1}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "запустите от root: … | sudo bash"

say "1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "нет docker compose — обновите Docker"

# Что ставить: заданная ветка или последний релиз (нет релизов — main).
REF="${BRANCH:-}"
if [ -z "$REF" ]; then
  REF="$(curl -fsS --max-time 20 "$API" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
  REF="${REF:-main}"
fi

say "2/5 Код Kayospace ($REF)"
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq git
fi
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$REF"
  git -C "$DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
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

# Стоит релиз — запоминаем, чтобы автообновление не пересобирало его же.
case "$REF" in v[0-9]*) echo "$REF" > .deployed ;; *) rm -f .deployed ;; esac

if [ "$AUTO_UPDATE" != 0 ] && command -v systemctl >/dev/null 2>&1; then
  say "Автообновление"
  install -m 755 "$DIR/deploy/update.sh" /usr/local/sbin/kayospace-update
  cat > /etc/systemd/system/kayospace-update.service <<UNIT
[Unit]
Description=Kayospace: обновить хаб до последнего релиза
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=DIR=$DIR
ExecStart=/usr/local/sbin/kayospace-update
TimeoutStartSec=30min
UNIT
  cat > /etc/systemd/system/kayospace-update.timer <<UNIT
[Unit]
Description=Kayospace: проверять новые релизы раз в 10 минут

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now kayospace-update.timer >/dev/null
  echo "Хаб сам перейдёт на новый релиз в течение 10 минут после выхода (журнал: journalctl -u kayospace-update)."
fi

cat <<EOF

Готово. Хаб работает: $HUB_URL

  Адрес хаба:  $HUB_ADDR
  Ключ администратора (HUB_TOKEN): $HUB_TOKEN
  На устройствах ключ не нужен — он для коннектора Claude, Claude Code и восстановления доступа.

Коннектор в приложении Claude (claude.ai, телефон, компьютер):
  Настройки → Коннекторы → Добавить свой коннектор → URL: $HUB_URL/mcp
  → «Подключить» → на странице хаба вставьте ключ → «Разрешить»

Claude Code на своём компьютере:
  claude mcp add --transport http kayospace $HUB_URL/mcp --header "Authorization: Bearer $HUB_TOKEN"

ИИ в доске (кнопка «✦ ИИ») на этом сервере — по желанию:
  1) на своём компьютере: claude setup-token  (выдаст токен подписки)
  2) добавьте в $DIR/deploy/.env строки:
       COMPOSE_PROFILES=ai
       CLAUDE_CODE_OAUTH_TOKEN=<токен из шага 1>
  3) cd $DIR/deploy && docker compose up -d --build

Ещё устройство:    в приложении Настройки → Устройства → «+ Добавить»
                   или здесь: cd $DIR/deploy && docker compose exec hub pnpm pair
Обновления:        сами, по релизам (journalctl -u kayospace-update; сейчас: systemctl start kayospace-update)
Логи:              cd $DIR/deploy && docker compose logs -f hub   (ИИ: … logs -f ai-worker)
Резервная копия:   docker run --rm -v kayospace_hub-data:/data -v "\$PWD":/backup alpine tar czf /backup/kayospace-boards.tgz -C /data .
Показать ключ:     cat $DIR/deploy/.env
EOF

say "Подключите первое устройство"
# Код живёт 5 минут; не успели — `docker compose exec hub pnpm pair` выдаст новый.
docker compose exec -T hub pnpm pair ||
  echo "Не получилось выдать код. Позже: cd $DIR/deploy && docker compose exec hub pnpm pair"
