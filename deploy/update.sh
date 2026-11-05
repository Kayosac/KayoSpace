#!/usr/bin/env bash
# Автообновление хаба Kayospace до последнего релиза (решение 0014).
#
# Ставит setup.sh: копия скрипта — /usr/local/sbin/kayospace-update, запуск — systemd-таймер
# kayospace-update.timer раз в 10 минут. Вручную: systemctl start kayospace-update
# Журнал: journalctl -u kayospace-update
#
# 1. Узнаёт последний релиз (vX.Y.Z) через API GitHub.
# 2. Тот же, что стоит, или тот, что уже не поднялся, — ничего не делает.
# 3. Иначе — код релиза, пересборка, проверка /health. Не ответил за 3 минуты — откат на прежний код
#    и запоминает неудачный релиз, чтобы не пересобирать его каждые 10 минут.
set -euo pipefail

DIR="${DIR:-/opt/kayospace}"
API="${API:-https://api.github.com/repos/Kayosac/KayoSpace/releases/latest}"
INSTALL_TO="${INSTALL_TO:-/usr/local/sbin/kayospace-update}"
HEALTH_TRIES="${HEALTH_TRIES:-36}"
HEALTH_SLEEP="${HEALTH_SLEEP:-5}"
STATE="$DIR/deploy/.deployed"
FAILED="$DIR/deploy/.failed"

log() { echo "[kayospace-update] $*"; }

cd "$DIR/deploy"
# Два обновления сразу (таймер и ручной запуск) не нужны.
exec 9>"$DIR/deploy/.update.lock"
flock -n 9 || { log "обновление уже идёт"; exit 0; }

TAG="$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' "$API" |
  sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log "не удалось узнать последний релиз — попробую позже"
  exit 0
fi
CURRENT="$(cat "$STATE" 2>/dev/null || true)"
[ "$TAG" = "$CURRENT" ] && exit 0
if [ "$TAG" = "$(cat "$FAILED" 2>/dev/null || true)" ]; then
  log "$TAG уже не поднялся — жду следующий релиз"
  exit 0
fi

# shellcheck disable=SC1091
. ./.env
if [ "${HTTPS_PORT:-443}" = 443 ]; then URL="https://$HUB_DOMAIN"; else URL="https://$HUB_DOMAIN:$HTTPS_PORT"; fi

healthy() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS --max-time 5 "$URL/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

PREV="$(git -C "$DIR" rev-parse HEAD)"
log "обновляю ${CURRENT:-текущую версию} → $TAG"
git -C "$DIR" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
git -C "$DIR" reset --hard "$TAG"

# Пока собирается новый образ, работает прежний хаб; перерыв — только на перезапуск контейнера.
if docker compose up -d --build --remove-orphans && healthy; then
  echo "$TAG" > "$STATE"
  rm -f "$FAILED"
  # Новая версия этого скрипта — для следующих запусков.
  install -m 755 "$DIR/deploy/update.sh" "$INSTALL_TO" 2>/dev/null || true
  log "готово: $TAG"
  exit 0
fi

log "$TAG не ответил по $URL/health — откатываю на прежний код"
echo "$TAG" > "$FAILED"
git -C "$DIR" reset --hard "$PREV"
docker compose up -d --build --remove-orphans || true
if healthy; then log "откат удался, работает прежняя версия"; else log "и после отката хаб не отвечает — смотрите docker compose logs"; fi
exit 1
